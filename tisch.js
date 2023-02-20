// If `define` is defined, use that. Otherwise, assume we're in node and use
// `require` and `module.exports`.
(function () {
    if (typeof define === 'undefined') {
        // use node-style modules
        return function (deps, init) {
            module.exports = init(...deps.map(require));
        };
    } else {
        // use AMD-style modules
        return define;
    }
}())(['vm', 'util', 'path', 'child_process', 'fs'],
function (vm, util, path, child_process, fs) {
'use strict';

const etcSymbol = Symbol('tisch.etc'),
      orSymbol = Symbol('tisch.or'),
      anySymbol = Symbol('tisch.any'),
      placeholderSymbol = Symbol('tisch.placeholder'),
      recursiveSchemas = new Map(), // schema -> undefined | function
      str = obj => util.inspect(obj, {depth: null});

function etc(min, max) {
    let self = {
        [etcSymbol]: {min, max},
        [Symbol.iterator]: function* () {
                yield self;
        }
    };

    return self;
}

function isEtc(pattern) {
    // We could just use `pattern[etcSymbol]`, but that breaks with `null`.
    // Hence this function.
    return ['object', 'function'].indexOf(typeof pattern) !== -1 && pattern !== null && pattern[etcSymbol];
}

// `recursive` uses placeholder objects (objects with a `placeholderSymbol`
// property) provided by a `Proxy`. The placeholders are then filled with the
// compiled schemas during compilation.
function recursive(schemaProducer) {
    // property access handler for the proxy
    const placeholders = {};
    // `proxyPassthrough` determines whether the `proxy`, below, actually does
    // its job of minting placeholder objects, or if it's "disabled" and
    // should instead pass through property access to its target object,
    // `placeholder`. `proxyPassthrough` is used for the case where
    // `schemaProducer` didn't access any properties on the proxy. In that
    // case, we want the proxy itself to act as a placeholder; to prevent
    // subsequent compilation from breaking, we have to disable the proxy so
    // that it behaves like a normal object.
    let proxyPassthrough = false;
    const handler = {
        get: function (target, property) {
            // `target` is another name for `placeholders` (that's just how
            // proxies work).

            if (proxyPassthrough) {
                // See the definition of `proxyPassthrough` for an explanation.
                return target[property];
            }

            if (property in target) {
                return target[property];
            }
            else {
                // `property` is used as a dummy (placeholder...) value. It will be
                // replaced with a schema after we call `schemaProducer`.
                return target[property] = {[placeholderSymbol]: property}
            }
        }
    };
    const proxy = new Proxy(placeholders, handler);

    const schemas = schemaProducer(proxy);

    // If there were not any placeholders produced, then treat `schemas` as a
    // single schema value, and use the `proxy` object itself as the
    // placeholder (since that's what `schemaProducer` was given). This covers
    // the common case where you're recursing on one schema only (non-mutual
    // recursion), and so just use the function argument without destructuring
    // it.
    if (Object.keys(placeholders).length === 0) {
        const schema = schemas;
        const placeholder = proxy;
        proxyPassthrough = true;
        // `true` is used as a dummy value until we have the compiled validator.
        placeholder[placeholderSymbol] = true;
        // We'll look at `recursiveSchemas` during compilation. See
        // `validatorImpl`.
        recursiveSchemas.set(schema, placeholder);
    }
    // Otherwise, treat `schemas` as an object of `{<name>: <schema>}`.
    else {
        Object.entries(schemas).forEach(([name, schema]) => {
            // We'll look at `recursiveSchemas` during compilation. See
            // `validatorImpl`.
            recursiveSchemas.set(schema, placeholders[name]);
        });
    }

    return schemas;
}

// It is possible to have mutually recursive schemas, where one part of the mutual recursion is
// not visible directly from the returned schema. In these cases, we must make sure that we've
// compiled all recursive components and updated their placeholders.
// TODO: I added this as a hack to fix a bug due to a design oversight. Another
// design might be simpler.
function finishRecursiveSchemas(errors) {
    if (recursiveSchemas.size === 0) {
        return;
    }

    const schema = recursiveSchemas.keys().next();
    // `validatorImpl` has the side effect of updating placeholders to contain
    // the resulting validator, so we don't need to do anything with the return
    // value here.
    validatorImpl(schema, errors);
    finishRecursiveSchemas(errors);
}

// Make `...etc` work like `...etc()`.
const defaultEtc = etc();
[etcSymbol, Symbol.iterator].forEach(key => etc[key] = defaultEtc[key]);

function or(...patterns) {
    return {
        [orSymbol]: patterns
    };
}

 // Since we decided that an empty `or` matches anything, `Any` can be
 // implemented in terms of `or`.
const Any = or();

// `Any` can also be used as a computed property name, e.g.
//
//     {
//         [Any]: {foo: Number, bar: [String, ...etc]}
//     }
//
// matches an object that has any one property, and where the value at that one
// property is an object containing a property "foo" that's a number... (and so
// on).
//
// If `Any` is used as a computed property name, then it must be the only
// property. Otherwise I have to solve the n rooks problem, and I have no
// current need for that anyway, so screw it.
//
// To implement this, `Any` has a custom `toString` method that returns a
// special `Symbol` (a `Symbol`, not a string).
Any.toString = () => anySymbol;

function isObject(value) {
    // Good enough. Google "javascript check if object is object literal."
    return Object.prototype.toString.call(value) === '[object Object]';
}

// A validator is just a function that returns true or false, and as a side
// effect might append to a bound array of error diagnostics.
// When a user invokes a validator, we want the array of errors to get
// cleared first. The problem is that validators can call each other -- we
// wouldn't want one validator clearing the error array used by the other
// validators. So, no validators do any clearing, and then the final "root"
// validator is wrapped with a function that does the clearing, and this is
// the function that the user sees.
// Additionally, `wrappedValidator` adds an `enforce` method to the returned
// function. `enforce` invokes the function with its argument, and if the result
// is `false`, throws an `Error` containing a formatted diagnostic based on
// `errors`. If instead the result is `true`, `enforce` returns its argument.
function wrappedValidator(impl, errors) {
    // `errors` gets cleared (but never reassigned) each time the returned
    // function is invoked. The returned function returns a boolean, but if it
    // returns `false`, the caller can find out why by inspecting `.errors`.
    const validate = function (value) {
        errors.length = 0;
        const matched = impl(value);

        // If we _did_ match, then there might still be strings in
        // `errors`, e.g. if we matched the `c` in `or(a, b, c)`, then
        // `errors` will contain the diagnostics from failing to match
        // `a` and `b`. In this case, clear `errors`.
        if (matched) {
            errors.length = 0;
        }

        return matched;
    };

    validate.errors = errors;

    validate.enforce = function (object) {
        if (!validate(object)) {
            throw Error(errors.join('\n'));
        }
        return object;
    };

    return Object.freeze(validate);
}

function validatorImpl(schema, errors) {
    // If this is a recursive schema, then after compiling it we need to
    // update references to it with the compiled version.
    if (recursiveSchemas.has(schema)) {
        const placeholder = recursiveSchemas.get(schema);
        recursiveSchemas.delete(schema);
        const validator = validatorImpl(schema, errors);
        placeholder[placeholderSymbol] = validator;
        return validator;
    }

    if (typeof schema === 'function' && schema.name === 'Buffer') {
        return stupidTypeValidator(schema, errors);
    }

    if (typeof schema === 'function' &&
        ['Number', 'Boolean', 'Object', 'Array', 'String'].includes(schema.name)) {
        return typeValidator(schema, errors);
    }
    // When multiple inter-dependent schemas are loaded together, two schemas
    // might both contain a third, and so one of them will compile the third
    // first. That means that the other will see the _compiled_ version, so we
    // need to be able to detect when our input is already compiled. What that
    // looks like is a function that isn't one of the above (Boolean, etc.).
    if (typeof schema === 'function') {
        return schema;
    }
    if (['string', 'number', 'boolean'].includes(typeof schema) || schema === null) {
        return literalValidator(schema, errors);
    }
    if (Array.isArray(schema)) {
        return arrayValidator(schema, errors);
    }

    if (schema instanceof Map) {
        // A Map schema is translated into a validator that converts a
        // specified Map argument into an array of name/value pairs,
        // i.e. Map(x -> y, z -> w) -> [[x, y], [z, w]]
        // and validates the transformed value against a corresponding
        // array validator deduced from the Map schema.
        // TODO: Maybe a hack, maybe saves lines of code.
        // TODO: It'll also produce confusing error messages.
        //
        // However, if the map has any optional keys, i.e. string-valued keys
        // ending in "?", then transform the map into an object and pass it
        // along to the object validator functions.
        // TODO: Definitely a hack, but I'm an honest man with simple tastes
        // and schema validation is one of them.
        //
        if (!Array.from(schema.keys()).some(key => typeof key === 'string' && key.endsWith('?'))) {
            return mapValidator(schema, errors);
        }

        schema = Object.fromEntries(Array.from(schema.entries()).map(([key, value]) => {
            // `etc` is weird in maps.
            // TODO: Can this be fixed elsewhere?
            if (isEtc(key)) {
                return [etcSymbol, key[etcSymbol]];
            }
            return [key, value];
        }));
    }

    if (!isObject(schema)) {
        throw Error(`Invalid schema subpattern: ${str(schema)}`);
    }
    // We're dealing with an object. It might be an object pattern, but it
    // also might be an object with a special case `Symbol` key that requires
    // special treatment.
    if (schema[orSymbol]) {
        return orValidator(schema[orSymbol], errors);
    }
    if (schema[anySymbol]) {
        return wildcardObjectValidator(schema, errors);
    }
    if (schema[placeholderSymbol]) {
        return placeholderValidator(schema);
    }
    return objectValidator(schema, errors);
}

// TODO: Transforming to an array was a mistake.
// I thought that order dependence was ok, but it breaks optional elements.
function mapValidator(schema, errors) {
    const arraySchema = Array.from(schema.entries()).map(([key, value]) => {
        if (isEtc(key)) {
            return key;
        }
        return [key, value];
    });

    const arrayifiedValidator = arrayValidator(arraySchema, errors);

    return function (value) {
        // If it's not a Map, then see if it's a plain object. If it's a plain
        // object, tolerate that. Otherwise, false.
        //
        // On the other hand, if it is a Map, then convert it into an Array and
        // validate it against the transformed validator.
        if (isObject(value)) {
            value = new Map(Object.entries(value));
        }

        if (!(value instanceof Map)) {
            errors.push(`It's not a Map: ${value}`);
            return false;
        }
        return arrayifiedValidator(Array.from(value.entries()), errors);
    };
}

function placeholderValidator(schema) {
    return function (value) {
        const actualValidator = schema[placeholderSymbol];
        return actualValidator(value);
    };
}

function getProto(value) {
    // Corner cases: `null` and `undefined` don't have prototypes.
    if (value === null || value === undefined) {
        return undefined;
    }

    return Object.getPrototypeOf(value);
}

function stupidTypeValidator(type, errors) {
    // `type` is a factory function, like `Buffer`, whose values are instances
    // of the type, so we can just use `instanceof`.
    return function (value) {
        if (value instanceof type) {
            return true;
        }
        errors.push(`expected value of type ${type.name} but got value of type ${typeof value}: ${str(value)}`);
        return false;
    };
}

function typeValidator(type, errors) {
    // `type` is really a factory function, like `Number`, so we create a
    // default instance using `type` and compare its prototype with `value`.
    const proto = getProto(type());
    return function (value) {
        if (getProto(value) === proto) {
            return true;
        }
        errors.push(`expected value of type ${type.name} but got value of type ${typeof value}: ${str(value)}`);
        return false;
    };
}

function literalValidator(expected, errors) {
    return function (value) {
        if (value === expected) {
            return true;
        }
        errors.push(`expected ${JSON.stringify(expected)} but got: ${str(value)}`);
        return false;
    };
}

function integerValidator(value) {
    return typeof value === 'bigint' || Number.isInteger(value);
}

function checkIsArray(value, errors) {
    if (Array.isArray(value)) {
        return true;
    }
    errors.push(`expected an array but received a ${typeof value}: ${str(value)}`);
    return false;
}

function arrayValidator(elements, errors) {
    // If there are fewer than two elements, then we're just doing
    // element-wise matching ("...etc" won't come into play).
    if (elements.length < 2) {
        return fixedArrayValidator(elements, errors);
    }

    // There are at least two elements in the array of patterns. If the last
    // element is an `etc`, then treat the preceding pattern specially. If
    // not, then it's just a `fixedArrayValidator` (as above).
    const last = elements[elements.length - 1];
    if (!isEtc(last)) {
        return fixedArrayValidator(elements, errors);
    }

    const occurence = last[etcSymbol],
          repeatable = elements[elements.length - 2],
          fixed = elements.slice(0, elements.length - 2);
    return dynamicArrayValidator(fixed, repeatable, occurence, errors);
}

function fixedArrayValidator(patterns, errors) {
    if (patterns.some(isEtc)) {
            throw Error(`"...etc" cannot appear in an array except at the end.`);
    }

    const validators = patterns.map(pattern => validatorImpl(pattern, errors));

    return function (value) {
        if (!checkIsArray(value, errors)) {
            errors.push(`...occurred in array pattern ${str(patterns)}`);
            return false;
        }
        if (value.length !== patterns.length) {
            errors.push(`wrong number of array elements. Expected ${patterns.length} in ${str(patterns)} but got ${value.length}: ${str(value)}`);
            return false;
        }
        if (!validators.every((validate, i) => validate(value[i]))) {
            errors.push(`...occurred in array pattern ${str(patterns)}`);
            return false;
        }
        return true;
    };
}

function dynamicArrayValidator(fixed, repeatable, {min=0, max=Infinity}, errors) {
    const fixedValidator = fixedArrayValidator(fixed, errors),
          repeatableValidator = validatorImpl(repeatable, errors);

    return function (value) {
        if (!checkIsArray(value, errors)) {
            errors.push(`...occurred in array pattern ${str([...fixed, repeatable, etc])}`);
            return false;
        }

        const fixedPart = value.slice(0, fixed.length);
        if (!fixedValidator(fixedPart)) {
            return false;
        }

        // Now each remaining element must satsify `repeatableValidator`.
        const repeatablePart = value.slice(fixed.length),
              len = repeatablePart.length;
        if (len < min || len > max) {
            errors.push(`...etc(${min}, ${max}) at end of array pattern, but candidate array has ${len} trailing elements: ${str(repeatablePart)}`);
            return false;
        }

        const matched = repeatablePart.every(repeatableValidator);
        if (!matched) {
            errors.push(`Not every trailing element matched the pattern ${str(repeatable)}: ${str(repeatablePart)}`);
        }
        return matched;
    };
}

// Remove the specified count `n` elements from the end of the specified
// `array`. Return an array containing the elements removed. Note that `array`
// is modified in-place.
function popN(array, n) {
    return array.splice(-n, n);
}

// or(patterns...) -> {[orSymbol]: patterns}
function orValidator(patterns, errors) {
    const validators = patterns.map(pattern => validatorImpl(pattern, errors))
    if (validators.length === 0) {
        return () => true;
    }
    return function (value) {
        // Find the first validator that passes.
        const numFailed = validators.findIndex(validate => validate(value));
        const matched = numFailed !== -1;
        if (!matched) {
            errors.push(`The value ${str(value)} did not match any of the "or" patterns: ${str(patterns)}`);
        }
        else {
            // We _did_ find one that succeeded. The ones before it (that
            // failed) logged errors. Remove those errors.
            popN(errors, numFailed);
        }
        return matched;
    };
}

// {[Any]: schema}
// {[Any]: schema, ...etc}
function wildcardObjectValidator(schema, errors) {
    const pattern = schema[anySymbol],
          validate = validatorImpl(pattern, errors);

    if (schema.length) {
        throw Error(`An object pattern with an Any property must have _only_ ` +
            `that property, but the following has additional ` +
            `properties ${str(Object.keys(schema))}: ${str(schema)}`);
    }

    return function (object) {
        const length = Object.keys(object).length;

        if (length !== 1 && !(etcSymbol in schema)) {
            errors.push(`Object does not match the pattern ${str(schema)} ` +
                `because the object has ${length} properties instead of ` +
                `exactly one: ${str(object)}`);
            return false;
        }

        const {min=0, max=Infinity} = schema[etcSymbol] || {min: 1, max: 1};
        if (length < min || length > max) {
            errors.push(`Object does not match the pattern ${str(schema)} ` +
                `because the object has ${length} properties while between ` +
                `${min} and ${max} are required.`);
            return false;
        }

        if (!Object.values(object).every(validate)) {
            errors.push(`...occurred in wildcard object pattern ${str(schema)}`);
            return false;
        }

        return true;
    };
}

// {foo: schema1, bar: schema2}
// {foo: schema1, bar: schema2, ...etc}
function objectValidator(schema, errors) {
    // An object validator has zero or more required keys, optional keys, and
    // possibly accepts some amount of additional keys depending on whether
    // there's an `...etc`.
    // An optional key is a string that ends with a question mark ("?").

    // `min` and `max` as in "minimum and maximum number of allowed keys aside
    // from those that are required or optional."
    const {min=0, max=Infinity} = schema[etcSymbol] || {min: 0, max: 0},
          required = {}, // {key: validator}
          optional = {}; // {key: validator}

    // Fill in `required` and `optional`.
    Object.entries(schema).forEach(([key, pattern]) => {
        if (key.endsWith('?')) {
            optional[key.slice(0, -1)] = validatorImpl(pattern, errors);
        }
        else {
            required[key] = validatorImpl(pattern, errors);
        }
    });

    return function (object) {
        if (object instanceof Map) {
            object = Object.fromEntries(object.entries());
        }

        if (!isObject(object)) {
            errors.push(`expected an object literal for pattern ${str(schema)}, but received a ${typeof object}: ${str(object)}`);
            return false;
        }

        // required fields
        let ok = Object.entries(required).every(([key, validate]) => {
            if (!(key in object)) {
                errors.push(`Missing required field ${JSON.stringify(key)} for pattern ${str(schema)}: ${str(object)}`);
                errors.push(`The following fields are required: ${str(Object.keys(required))}`);
                return false;
            }
            if (!validate(object[key])) {
                errors.push(`...occurred at required field ${JSON.stringify(key)} in ${str(schema)}`);
                return false;
            }
            return true;
        });

        if (!ok) {
            return false;
        }

        // optional fields, and keep track of what else remains
        const leftovers = {};
        ok = Object.entries(object).every(([key, value]) => {
            if (key in optional) {
                if (!optional[key](value)) {
                    errors.push(`...occurred at optional field ${JSON.stringify(key)} in ${str(schema)}`);
                    return false;
                }
            }
            else if (!(key in required)) {
                // It's neither in `optional` nor in `required`, so it's extra.
                leftovers[key] = value;
            }
            return true;
        });

        if (!ok) {
            return false;
        }

        // Finally, make sure that the number of leftover fields is acceptable.
        const len = Object.keys(leftovers).length;
        if (len < min || len > max) {
            errors.push(`Encountered ${len} extra fields but expected between ${min} and ${max} while matching pattern ${str(schema)}: ${str(leftovers)}`);
            return false;
        }

        return true;
    };
}

// Escape any characters in the specified `text` that could be used for
// command injection when appearing as a globbable shell command argument.
// Note that quotes are escaped as well.
function sanitize(text) {
    return text.replace(/['";`|&#$(){}]|\s/g, char => '\\' + char);
}

// Return an array of path strings matching the specified shell glob
// `patterns`.
function glob(...patterns) {
    // `-1` means "one column," which puts each path on its own line.
    // `--directory` means "don't list a directory's contents, just its name."
    // The `while` loop is to unquote results that contain spaces, e.g.
    // if a matching file is called `foo bar`, `ls` will print `'foo bar'`,
    // but we want `foo bar`.
    const sanitizedPatterns = patterns.map(sanitize),
          command = [
              'ls', '--directory', '-1', ...sanitizedPatterns,
              '| while read line; do echo "$line"; done'
          ].join(' '),
          options = {encoding: 'utf8'},
          output = child_process.execSync(command, options),
          lines = output.split('\n');

    // The `ls` output will end with a newline, so `lines` has an extra empty.
    lines.pop();
    return lines;
}

// Return a validator compiled from the file at the specified `schemaPath`.
// The specified array for `errors` will be bound inside the validator. Since
// validators can depend on each other, use the specified registry of
// `validators` (`{<path>: <validator>}`) to look up or populate dependent
// validators. The returned validator will also be added to `validators`. Note
// that the returned validator function does not clear `errors`. For that it
// must be wrapped (see `wrappedValidator`).
function compileFile(schemaPath, validators, errors) {
    // We're traversing a directed graph.
    if (schemaPath in validators) {
        return validators[schemaPath];
    }

    const schemaString = fs.readFileSync(schemaPath, {encoding: 'utf8'}),
          schemaDir = path.dirname(schemaPath),
          validator = compileImpl(schemaString, schemaDir, validators, errors);

    return validators[schemaPath] = validator;
}

// Return a validator function compiled from the specified `schema`, where
// `schema` is either a string to be parsed an executed, or a function to be
// executed. Use the specified `schemaDir` as the effective working directory
// (for finding dependent schema files). The specified array of `errors` will
// be bound inside of the validator. Since validators can depend on each other,
// use the specified `validators` (`{<path>: <validator>}`) to look up or
// populate dependent validators. Note that the returned validator function
// does not clear `errors`. For that it must be wrapped (see
// `wrappedValidator`).
function compileImpl(schema, schemaDir, validators, errors) {
    // Here we define a function that is the `define` equivalent for tisch
    // schemas. It allows a schema to say, "I depend on these other schemas,
    // and please bind them to the arguments of this function, which will
    // return my schema."
    // For example, a schema describing a boy scout might depend on a schema
    // that describes boy scout badges and another that describes camping
    // locations. Then `boyscout.tisch.js` could look like this:
    //
    //     define(['./badge.tisch.js', './campsite.tisch.js'],
    //         (badge, campsite)  => ({
    //             'name': String,
    //             'birth_year': Number,
    //             'trips': [{
    //                 'site': campsite,
    //                 'year': Number,
    //                 'badges_received': [badge, ...etc]
    //             }, ...etc]
    //         }));
    //
    // An example boy scout might be:
    //
    //     {
    //         name: "Muhammad Al-Shamali",
    //         birth_year: 1987,
    //         trips: [{site: 'TURKEY_LAKE', year: 2000, badges_received: []},
    //                    {site: 'TURKEY_LAKE', year: 2001,
    //                     badges_received: ['WOODWORKING']}]
    //     }
    //
    // Dependencies are paths to tisch schema files, relative to the directory
    // of the current file (i.e. the file with the `define` call).

    function defineSchema(deps, init) {
        // `deps` are relative to `schemaDir`. Make them relative to `./`.
        const dep_schemas = deps.map(depPath => {
            const rebasedDepPath =
                path.normalize(path.join(schemaDir, depPath));

            return compileFile(rebasedDepPath, validators, errors);
        });

        return init(...dep_schemas);
    }

    // the return value
    let validator;

    if (typeof schema === 'string') {
        validator = compileStringImpl(schema, defineSchema, errors);
    }
    else {
        validator = compileFunctionImpl(schema, defineSchema, errors);
    }

    // See the definition of `finishRecursiveSchemas` for an explanation of why
    // this is necessary.
    finishRecursiveSchemas(errors);

    return validator;
}

// Return an object `{<path>: <validator>}` of validator functions compiled
// from files whose paths match any of the specified `glob_patterns`. The
// globbing is done relative to the current working directory. The returned
// validator functions clear their `.error` array when called (so errors from
// previous invocations are not preserved).
function compileFiles(...glob_patterns) {
    const paths = glob(...glob_patterns),
          validators = {},
          errors = [];

    paths.forEach(schemaPath => compileFile(schemaPath, validators, errors));

    // `validators` now maps schema file paths to validator functions. All of
    // the validator functions have `errors` bound within them. Wrap each
    // validator function in a function that first clears `errors`, and then
    // calls the underlying validator.
    Object.entries(validators).forEach(
        ([key, validate]) =>
            validators[key] = wrappedValidator(validate, errors));

    return validators;
}

// Return a validator function compiled from the file at the specified
// `schemaPath`. The returned validator function clears its `.error` array when
// called (so errors from previous invocations are not preserved).
function compileOneFile(schemaPath) {
    const validators = {},
          errors = [];

    compileFile(schemaPath, validators, errors);
    const validate = validators[schemaPath];

    return wrappedValidator(validate, errors);
}

function map(...entries) {
    const result = new Map();
    entries.forEach(entry => {
        if (isEtc(entry)) {
            // TODO: There might be a better way.
            // Instead of  `{[etcSymbol]: ...} -> undefined`, we could have
            // `etcSymbol -> ...`.
            // But I tried it and ran into issues with `etcSymbol` being a key
            // in some other context. Worth revisiting.
            result.set(entry);
        } else {
            const [key, value] = entry;
            result.set(key, value);
        }
    });
    return result;
}

// This is the core compilation function: all of the other `compile*`
// functions are wrappers that ultimately call `compileStringImpl`.
//
// Return a validator function compiled from the specified `schemaString`.
// Bind the specified `schemaDefiner` function as "define" in the global
// environment of the evaluated code -- the evaluated schema can use it to
// depend upon schemas in other files. The specified array of `errors` will be
// bound within the returned validator.
function compileStringImpl(schemaString, schemaDefiner, errors) {
    const context = {
        // Use the _same_ builtin globals so we can compare value prototypes.
        Number, Boolean, Object, String, Array,
        // Tisch-specific globals.
        etc, or, Any, recursive,
        Integer: integerValidator,
        map,
        define: schemaDefiner
    };
    vm.createContext(context);

    const schema = vm.runInContext(schemaString, context);
    return validatorImpl(schema, errors);
}

// This is like `compileStringImpl`, except instead of evaluating a string of
// tisch, we execute a function of tisch.
function compileFunctionImpl(func, schemaDefiner, errors) {
    const context = {
        // Tisch-specific globals. The builtin globals are already accessible
        // to `func`.
        etc, or, Any, recursive,
        Integer: integerValidator,
        map,
        define: schemaDefiner
    };

    const schema = func(context);
    return validatorImpl(schema, errors);
}

// Return a validator function compiled from the specified `schema`, where
// `schema` is either a string to be parsed and evaluated or a function to be
// executed. The `.error` property of the returned validator function will be
// cleared at the beginning of each invocation (so errors from previous
// invocations are not preserved).
function compile(schema) {
    const validators = {},
          errors = [],
          // You gave just a string or a function (not a file), so dependency
          // paths will be relative to the current working directory.
          schemaDir = '.';
    return wrappedValidator(
        compileImpl(schema, schemaDir, validators, errors), errors);
}

return {
    compileString: compile,
    compileFiles,
    compileFile: compileOneFile,
    compileFunction: compile
};

});

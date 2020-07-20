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
      str = (...args) => util.inspect(...args);

function etc(min, max) {
    let self = {
        [etcSymbol]: {min, max},
        [Symbol.iterator]: function* () {
                yield self;
        }
    };

    return self;
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
    
    if (!isObject(schema)) {
        throw Error(`Invalid schema subpattern: ${str(schema)}`);
    }
    // We're dealing with an object. It might be an object pattern, but it
    // also might be an object with an `orSymbol` key, which we have to treat
    // specially.
    // Another special case is if the objec has an `anySymbol` property.
    if (schema[orSymbol]) {
        return orValidator(schema[orSymbol], errors);
    }
    if (schema[anySymbol]) {
        return wildcardObjectValidator(schema, errors);
    }
    return objectValidator(schema, errors);
}

function getProto(value) {
    // Corner cases: `null` and `undefined` don't have prototypes.
    if (value === null || value === undefined) {
        return undefined;
    }

    return Object.getPrototypeOf(value);
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

function isEtc(pattern) {
    // We could just use `pattern[etcSymbol]`, but that breaks with `null`.
    // Hence this function.
    return pattern !== null && pattern[etcSymbol];
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

function orValidator(patterns, errors) {
    const validators = patterns.map(pattern => validatorImpl(pattern, errors))
    if (validators.length === 0) {
        return () => true;
    }
    return function (value) {
        const matched = validators.some(validate => validate(value));
        if (!matched) {
            errors.push(`The value ${str(value)} did not match any of the "or" patterns: ${str(patterns)}`);
        }
        return matched;
    };
}

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

    if (typeof schema === 'string') {
        return compileStringImpl(schema, defineSchema, errors);
    }
    else {
        return compileFunctionImpl(schema, defineSchema, errors);
    }
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
        etc, or, Any,
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
        etc, or, Any,
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

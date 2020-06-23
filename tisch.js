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
}())(['vm', 'util'], function (vm, util) {
const etcSymbol = Symbol('tisch.etc'),
      orSymbol = Symbol('tisch.or'),
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

function isObject(value) {
    // Good enough. Google "javascript check if object is object literal."
    return Object.prototype.toString.call(value) === '[object Object]';
}

function validator(schema) {
    // This function is a little tricky. We want `errors` to be local to this
    // function, but also accessible as an output parameter to the function
    // returned by `validatorImpl`, and finally a property accessible on the
    // function object returned by this function.
    // `errors` gets cleared (but never reassigned) each time the returned
    // function is invoked. The returned function returns a boolean, but if it
    // returns `false`, the caller can find out why by inspecting `.errors`.
    const errors = [],
          impl = validatorImpl(schema, errors),
          validate = function (value) {
              errors.length = 0;
              return impl(value);
          };

    validate.errors = errors;

    // This is a little paranoid. `Object.freeze` will prevent reassignment of
    // `.errors`.
    return Object.freeze(validate);
}

function validatorImpl(schema, errors) {
    if (typeof schema === 'function' &&
        ['Number', 'Boolean', 'Object', 'Array', 'String'].includes(schema.name)) {
        return typeValidator(schema, errors);
    }
    if (['string', 'number', 'boolean'].includes(typeof schema) || schema === null) {
        return literalValidator(schema, errors);
    }
    if (Array.isArray(schema)) {
        return arrayValidator(schema, errors);
    }
    
    if (!isObject(schema)) {
        // TODO: better diagnostic
        throw Error(`Invalid schema subpattern: ${str(schema)}`);
    }
    // We're dealing with an object. It might be an object pattern, but it
    // also might be an object with an `orSymbol` key, which we have to treat
    // specially.
    if (schema[orSymbol]) {
        return orValidator(schema[orSymbol], errors);
    }
    return objectValidator(schema, errors);
}

function getProto(value) {
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

function isArray(value, errors) {
    if (Array.isArray(value)) {
        return true;
    }
    errors.push(`expected an array for pattern ${str(elements)} but received a ${typeof value}: ${str(value)}`);
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
            // TODO: better error handling
            throw Error(`"...etc" cannot appear in an array except at the end.`);
    }

    const validators = patterns.map(pattern => validatorImpl(pattern, errors));

    return function (value) {
        if (!isArray(value, errors)) {
            errors.push(`occurred in array pattern ${str(patterns)}`);
            return false;
        }
        if (value.length !== patterns.length) {
            errors.push(`wrong number of array elements. Expected ${patterns.length} in ${str(patterns)} but got ${value.length}: ${str(value)}`);
            return false;
        }
        if (!validators.every((validator, i) => validator(value[i]))) {
            errors.push(`occurred in array pattern ${str(patterns)}`);
            return false;
        }
        return true;
    };
}

function dynamicArrayValidator(fixed, repeatable, {min=0, max=Infinity}, errors) {
    const fixedValidator = fixedArrayValidator(fixed, errors),
          repeatableValidator = validatorImpl(repeatable, errors);

    return function (value) {
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
        // TODO: maybe add context to `errors` when the following fails.
        return repeatablePart.every(repeatableValidator);
    };
}

function orValidator(patterns, errors) {
    const validators = patterns.map(pattern => validatorImpl(pattern, errors))
    if (validators.length === 0) {
        return () => true;
    }
    return function (value) {
        // TODO: add context when the following fails.
        return validators.some(validate => validate(value));
    };
}

function objectValidator(schema, errors) {
    // An object validator has zero or more required keys, optional keys, and
    // possibly accepts some amount of additional keys depending on whether
    // there's an `...etc`.

    // `min` and `max` as in "minimum and maximum number of allowed keys aside
    // from those that are required or optional."
    const {min=0, max=Infinity} = schema[etcSymbol] || {min: 0, max: 0};
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
                return false;
            }
            if (!validate(object[key])) {
                errors.push(`occurred at required field ${JSON.stringify(key)} in ${str(schema)}`);
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
                    errors.push(`occurred at optional field ${JSON.stringify(key)} in ${str(schema)}`);
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

function compile(schemaString) {
    // Create a Javascript evaluation context that contains only core
    // Javascript (e.g. `JSON`, `Object`, `Number`, etc.) and additionally
    // some special identifiers defined here.
    const context = {etc, or, Any};
    vm.createContext(context);
    // Wrap it in parenthese so that {...} is an object, not a scope.
    const schema = vm.runInContext(`(${schemaString})`, context);
    return validator(schema);
}

return {compile};
});

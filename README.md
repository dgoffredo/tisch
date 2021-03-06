<img align="right" width="200" src="tisch.svg"/>

tisch
=====
a **ti**ny **sch**ema language for JSON

Why
---
[json-schema][1] has too much stuff.

What
----
Tisch is the smallest serviceable JSON-based schema validator I could come up
with.

How
---
[tisch.js](tisch.js) is an [asynchonous module][2] that exports functions for
converting _tisch schemas_ into functions that validate an object against the
schema.

For example,
```javascript
define(['tisch.js'], function (tisch) {
    // Here's a string containing a tisch schema, which is just javascript
    // code. This schema describes a JSON representation of a SQL table.
    const my_schema = `{
        name: String,
        columns: [{
            name: String,
            "is_nullable?": Boolean,
            "is_primary_key?": Boolean,
            "foreign_key?": {
                table: String,
                column: String,
                ...etc
            },
            protobuf_type: String,
            role: or(
                {message: String},
                {array: {message: String, field: String}},
                {enum: String})
        }, ...etc(1)]
    }`;

    const validate = tisch.compileString(my_schema);
    const valid = validate({
        name: 'ethnicity',
        columns: [
            {name: 'id', protobuf_type: 'int32', is_primary_key: true},
            {name: 'name', protobuf_type: 'string', is_nullable: false},
        ],
        role: {enum: 'Ethnicity'}
    });

    if (valid) {
        // This is the branch that will be executed.
        console.log('checks out');
    } else {
        // If the argument to `validate` didn't satisfy the schema, then this
        // branch would be executed.
        console.error('invalid table: ' + validate.errors.join('\n'));
    }
});
```

More
----
The following patterns are recognized:

### `Any`
Match any value.

`Any` may also be used as a computed property name. In that case, it matches
any property name. For example, the following schema matches any object with
exactly one property, where the value at that property is a number:
```javascript
({[Any]: Number})
```

If `Any` is used as a computed property name, then it must be the only
property in the pattern. For example, the following pattern is invalid:
```javascript
({
    [Any]: Number,
    extra: [String, ...etc] // error: "extra" is an extraneous key due to `Any`
})
```

However, `...etc` may be used to match zero or more occurrences of any
property whose value matches the corresponding pattern, e.g.
```javascript
({
    [Any]: Number,
    ...etc
})
```
is a valid pattern, and it matches any object having zero or more properties,
where the value at each property is a number.

### e.g. `"some javascript string"`
Match the string exactly.

### e.g. `34.54`
Match the number exactly.

### `null`
Match `null` exactly.

### `true`
Match `true` exactly.

### `false`
Match `false` exactly.

### `Object`
Match any object literal.

### `Array`
Match any array.

### `Boolean`
Match `true` or `false`

### `Number`
Match any number.

### `[]`
Match an empty array.

### `[pattern1, pattern2, ...]`
Match an array having the same length as the pattern, and whose corresponding
elements match the elements of the pattern.

### `[pattern1, ..., pattern_n, ...etc]`
Match an array having one or more elements, and whose corresponding
elements match the elements of the pattern, but additionally the array may
have zero or more trailing elements that match the last pattern before the
`...etc`.

### `{}`
Match an empty object literal.

### `{key: pattern, ...}`
Match an object having the same length as the pattern, having exactly the same
keys as the pattern (and no more), and where the value at each key matches the
corresponding pattern at that key in the pattern. **However, if a key in the
pattern ends with a question mark (`?`), then that key is optional.** Note that
this means that tisch does not support keys that actually end with a question
mark. That's fine, because you never do that anyway.

### `{key1: pattern1, ..., key_n: pattern_n ...etc}`
Match an object having one or more keys, where for each key in the pattern,
the corresponding value in the object matches the pattern at that key in the
pattern, but additionally the object may have other keys not in the pattern.

### `...etc`, `...etc(min)`, `..etc(min, max)`
`etc` is a special identifier in tisch schemas. It may appear as spread
syntax (i.e. preceded by `...`) either at the end of an array literal or at
the end of an object literal. Its behavior depends on the context.

At the end of an array literal, `...etc` matches multiple instances of the
pattern that immediately precedes it (the previous element in the array).

At the end of an object literal, `...etc` matches any additional entries in
the object (i.e. key/value pairs).

At the end of an object literal that contains `Any` as a computed property
name, `...etc` indicates that a matching object may have zero or more
entries, but the value in each entry must match the pattern associated with
the `Any` property.

`etc` may be invoked as a function. If it is _not_ invoked as a function, then
it matches "zero or more." If it is invoked as a function with one
non-negative integer argument `...etc(a)`, then it matches "`a` or more." If
it is invoked as a function with two non-negative integers arguments
`...etc(a, b)`, with `b >= a`, then it matches "at least `a` but at most `b`."

### `or(pattern1, pattern2, ...)`
`or` is a special function in tisch schemas. It matches any value that matches
at least one of its arguments.

### `define([dependencyPath, ...], function (dependency, ...) { ... })`
`define` is a special function in tisch schemas. It loads tisch schemas from
the files at the specified paths (`[dependencyPath, ...]`) and then invokes
the specified `function` with the loaded schemas as arguments (corresponding
to the paths). The function must return a schema (pattern). In this way,
schemas in separate files can refer to each other by name.

### `recursive(function (self) { ... })`
`recursive` is a special function in tisch schemas. It allows part of a schema's definition to reference itself. `recursive`'s single argument is a function, `func`, of one argument, `self`. There are two cases:
1. If no property is ever accessed on `self`, then `self` refers to value
   returned by `func`. Thus by returning a schema that involves `self`,
   `func` can define a recursive schema.
2. If properties are accessed on `self`, then each property value refers to
   a separate schema placeholder. `func` must then return an object mapping
   those property names to schema objects. Thus the values of the object
   returned by `func` are schemas defined in terms of themselves and of
   each other.

For example,
```javascript
recursive(expression => or(
        Number,
        {'+': [expression, ...etc]}))
```
is a schema that matches a number or a tree of `+` objects that contain
arrays of numbers or `+` objects.

Mutual recursion is possible by destructuring the argument into multiple
variables. For example,
```javascript
const {yin, yang} = recursive(({yin, yang}) => ({
    yin: [String, Number, yang, ...etc],
    yang: {'contrived': or(yin, String)}
}));
```
defines two schemas, `yin` and `yang`, whose definitions are mutually
recursive.

Enforce
-------
Each validator function has a method, `.enforce` (I know, a function
property on a function) that returns its argument if it satisfies the
schema, or throws an `Error` if it does not satisfy the schema. The
`Error`'s message contains the `.errors` of the validation function. For
example,
```javascript
define(['tisch.js'], function (tisch) {

const isLlama = tisch.compileFile('llama.tisch.js');

// `fred` is an object that satisfies the schema `llama.tisch.js`, or an
// `Error` is thrown.
const fred = isLlama.enforce({
    name: fred,
    height: {centimeters: 174},
    coat: 'tawny',
    spits: false
});
```
I found myself using the validator functions only to throw if they returned
false. So, the `.enforce` method simplifies that use case.

[1]: https://json-schema.org
[2]: https://github.com/amdjs/amdjs-api/blob/master/AMD.md

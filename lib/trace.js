'use strict';

const DeepEqual = require('@hapi/hoek/lib/deepEqual');
const Pinpoint = require('@hapi/pinpoint');

const Errors = require('./errors');


const internals = {
    codes: {
        error: 1,
        value: 2,
        full: 3
    },
    labels: {
        0: 'never used',
        1: 'always error',
        2: 'always pass'
    }
};


exports.setup = function (root) {

    const trace = function () {

        root._tracer = root._tracer || new internals.Tracer();
        return root._tracer;
    };

    root.trace = trace;
    root[Symbol.for('@hapi/lab/coverage/initialize')] = trace;

    root.untrace = () => {

        root._tracer = null;
    };
};


internals.Tracer = class {

    constructor() {

        this.name = 'Joi';
        this._schemas = new Map();
    }

    _register(schema) {

        const existing = this._schemas.get(schema);
        if (existing) {
            return existing.store;
        }

        const store = new internals.Store(schema);
        const { filename, line } = Pinpoint.location(4);        // internals.entry(), exports.entry(), validate(), caller
        this._schemas.set(schema, { filename, line, store });
        return store;
    }

    report(file) {

        const coverage = [];

        // Process each registered schema

        for (const { filename, line, store } of this._schemas.values()) {
            if (file &&
                file !== filename) {

                continue;
            }

            // Process sub schemas of the registered root

            const missing = [];
            const skipped = [];

            for (const [sub, log] of store._logs) {

                // Check if sub schema parent skipped

                if (internals.sub(log.paths, skipped)) {
                    continue;
                }

                // Check if sub schema reached

                if (!log.entry) {
                    missing.push({
                        status: 'never reached',
                        paths: [...log.paths]
                    });

                    skipped.push(...log.paths);
                    continue;
                }

                // Check values

                for (const type of ['valid', 'invalid']) {
                    const set = sub[`_${type}s`];
                    if (set) {
                        const values = new Set(set._set);
                        for (const value of log[type]) {
                            values.delete(value);
                        }

                        if (values.size) {
                            missing.push({
                                status: [...values],
                                rule: `${type}s`
                            });
                        }
                    }
                }

                // Check rules status

                const rules = sub._rules.map((rule) => rule.name);
                for (const type of ['default', 'failover']) {
                    if (sub._flags[type] !== undefined) {
                        rules.push(type);
                    }
                }

                for (const name of rules) {
                    const status = internals.labels[log.rule[name] || 0];
                    if (status) {
                        const report = { rule: name, status };
                        if (log.paths.size) {
                            report.paths = [...log.paths];
                        }

                        missing.push(report);
                    }
                }
            }

            if (missing.length) {
                coverage.push({
                    filename,
                    line,
                    missing,
                    severity: 'error',
                    message: `Schema missing tests for ${missing.map(internals.message).join(', ')}`
                });
            }
        }

        return coverage.length ? coverage : null;
    }
};


internals.Store = class {

    constructor(schema) {

        this._logs = new Map();
        this._scan(schema);
    }

    entry(schema) {

        const log = this._logs.get(schema);
        log.entry = true;
    }

    log(source, name, result, schema) {

        const log = this._logs.get(schema);

        log[source][name] = log[source][name] || 0;
        log[source][name] |= internals.codes[result];
    }

    value(source, value, schema) {

        const log = this._logs.get(schema);
        log[source].add(value);
    }

    _scan(schema, _path) {

        const path = _path || [];

        let log = this._logs.get(schema);
        if (!log) {
            log = {
                paths: new Set(),
                entry: false,
                rule: {},
                valid: new Set(),
                invalid: new Set()
            };

            this._logs.set(schema, log);
        }

        if (path.length) {
            log.paths.add(path);
        }

        const each = (sub, source) => {

            const id = internals.id(sub, source);
            this._scan(sub, path.concat(id));
        };

        schema.$_modify({ each, ref: false });
    }
};


internals.message = function (item) {

    const path = item.paths ? Errors.path(item.paths[0]) + (item.rule ? ':' : '') : '';
    return `${path}${item.rule || ''} (${item.status})`;
};


internals.id = function (schema, { source, name, path }) {

    if (schema._flags.id) {
        return schema._flags.id;
    }

    if (schema._flags._key) {
        return schema._flags._key;
    }

    name = `@${name}`;

    if (source === 'terms') {
        return [name, path[1]];
    }

    return name;
};


internals.sub = function (paths, skipped) {

    for (const path of paths) {
        for (const skip of skipped) {
            if (DeepEqual(path.slice(0, skip.length), skip)) {
                return true;
            }
        }
    }

    return false;
};
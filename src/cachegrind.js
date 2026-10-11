
//the metrics a profile can be shown by, as indexes into a node's self and total costs
export const TIME = 0;
export const MEMORY = 1;

//xdebug writes one block per call as the call returns, so a parsed profile is a full call tree:
//
//  { name, file, line, calls, self: [ time, memory ], total: [ time, memory ], children: [ node, ... ] }
//
//time is in nanoseconds and memory in bytes, children are in the order they were called

//profiles are usually gzipped, xdebug may also be configured to write them as plain text
export async function decode(buffer) {

    //
    const bytes = new Uint8Array(buffer);

    //
    if (bytes[0] !== 0x1f || bytes[1] !== 0x8b) {
        return new TextDecoder().decode(bytes);
    }

    //the request is sent before php has finished, so xdebug may not have finished writing the profile yet
    try {
        const stream = new Blob([ bytes ]).stream().pipeThrough(new DecompressionStream('gzip'));
        return await new Response(stream).text();
    } catch (err) {
        throw new Error('The profile is incomplete, Xdebug may still be writing it - try again in a moment');
    }

}

//
export function parse(text) {

    //xdebug's units, converted to nanoseconds and bytes - unknown events are ignored
    const scales = { 'Time_(10ns)': 10, 'Time_(ns)': 1, 'Time': 1, 'Memory_(bytes)': 1, 'Memory': 1 };
    let columns = [ [ TIME, 10 ], [ MEMORY, 1 ] ];

    //compressed names - "fn=(12) name" defines id 12, a later "fn=(12)" refers back to it - files share one table
    const files = new Map();
    const functions = new Map();

    //calls that have returned but whose caller hasn't yet - a caller's children are always the last ones on here
    const returned = [];

    //
    let summary = null;
    let file = '';
    let node = null;
    let callCount = 0;
    let isCallCost = false;
    let lastLine = 0;

    //
    const lines = text.split('\n');

    //
    for (let index = 0; index < lines.length; index++) {

        //
        const line = lines[index];
        const first = line.charCodeAt(0);

        //cost lines are by far the most common, "line time memory"
        if ((first >= 48 && first <= 57) || first === 43 || first === 45 || first === 42) {

            //
            const parts = line.split(' ');
            const costs = [ 0, 0 ];

            //
            for (let column = 0; column < columns.length; column++) {
                costs[columns[column][0]] = (Number(parts[column + 1]) || 0) * columns[column][1];
            }

            //positions may be relative to the previous one
            lastLine = position(parts[0], lastLine);

            //
            if (!node) {
                continue;
            }

            //the cost of a call is the callee's total, which we already have from the callee's own block - xdebug's
            //memory figure here doesn't always agree with the callee's, so totals are worked out from the tree instead
            if (isCallCost) {
                isCallCost = false;
                continue;
            }

            //
            node.line ??= lastLine;
            node.self[TIME] += costs[TIME];
            node.self[MEMORY] += costs[MEMORY];
            continue;

        }

        //
        const separator = line.indexOf('=');
        const key = separator === -1 ? '' : line.slice(0, separator);
        const value = separator === -1 ? '' : line.slice(separator + 1);

        //
        switch (key) {

            //
            case 'fl':
            case 'fi':
            case 'fe':
                file = lookup(files, value);
                break;

            //every fn line is a new call, so the previous one is complete
            case 'fn':
                finish();
                node = { name: lookup(functions, value), file, line: null, calls: 1, self: [ 0, 0 ], total: [ 0, 0 ], children: [] };
                break;

            //the callee is already on the returned stack, we only need the names defined here
            case 'cfl':
            case 'cfi':
                lookup(files, value);
                break;

            //
            case 'cfn':
                lookup(functions, value);
                break;

            //the next cost line is the cost of this call
            case 'calls':
                callCount++;
                isCallCost = true;
                break;

            //
            default:

                //
                if (line.startsWith('events:')) {
                    columns = line.slice(7).trim().split(/\s+/).map((event) => {
                        const metric = event.startsWith('Memory') ? MEMORY : TIME;
                        return [ metric, scales[event] ?? 1 ];
                    });
                }

                //
                if (line.startsWith('summary:')) {
                    const values = line.slice(8).trim().split(/\s+/);
                    summary = [ 0, 0 ];
                    columns.forEach(([ metric, scale ], column) => summary[metric] = (Number(values[column]) || 0) * scale);
                }

        }

    }

    //
    finish();

    //anything still waiting for a caller was called from the top level - main, shutdown functions and so on
    const root = { name: '(all)', file: '', line: null, calls: 1, self: [ 0, 0 ], total: [ 0, 0 ], children: returned };
    for (const child of returned) {
        root.total[TIME] += child.total[TIME];
        root.total[MEMORY] += child.total[MEMORY];
    }

    //
    return { root, summary: summary ?? root.total };

    //
    function finish() {

        //
        if (!node) {
            return;
        }

        //
        if (callCount > 0) {
            node.children = returned.splice(Math.max(0, returned.length - callCount), callCount);
        }

        //a frame is always exactly as wide as its own cost plus its children, so they never spill out of it
        node.total[TIME] = node.self[TIME];
        node.total[MEMORY] = node.self[MEMORY];
        for (const child of node.children) {
            node.total[TIME] += child.total[TIME];
            node.total[MEMORY] += child.total[MEMORY];
        }

        //
        returned.push(node);
        node = null;
        callCount = 0;
        isCallCost = false;

    }

}

//merges calls to the same function under the same parent, so repeated calls show as a single wider frame
export function leftHeavy(node) {

    //
    const merged = { name: node.name, file: node.file, line: node.line, calls: node.calls, self: [ ...node.self ], total: [ ...node.total ], children: [] };
    const byName = new Map();

    //children are merged before they are themselves merged, so collect every call to each function first
    for (const child of node.children) {

        //
        const existing = byName.get(child.name);
        if (existing) {
            existing.push(child);
        } else {
            byName.set(child.name, [ child ]);
        }

    }

    //
    for (const calls of byName.values()) {
        merged.children.push(calls.length === 1 ? leftHeavy(calls[0]) : leftHeavy(combine(calls)));
    }

    //the heaviest child goes first - for both metrics, sorted when first shown
    merged.sorted = [];

    //
    return merged;

}

//the children of a node in display order - left heavy trees are sorted by the metric being shown
export function childrenOf(node, metric) {

    //
    if (!node.sorted) {
        return node.children;
    }

    //
    node.sorted[metric] ??= [ ...node.children ].sort((a, b) => b.total[metric] - a.total[metric]);

    //
    return node.sorted[metric];

}

//several calls to one function as if they were one call, with all of their children
function combine(calls) {

    //
    const combined = { name: calls[0].name, file: calls[0].file, line: calls[0].line, calls: 0, self: [ 0, 0 ], total: [ 0, 0 ], children: [] };

    //
    for (const call of calls) {
        combined.calls += call.calls;
        combined.self[TIME] += call.self[TIME];
        combined.self[MEMORY] += call.self[MEMORY];
        combined.total[TIME] += call.total[TIME];
        combined.total[MEMORY] += call.total[MEMORY];
        combined.children.push(...call.children);
    }

    //
    return combined;

}

//
function lookup(table, value) {

    //
    const match = /^\((\d+)\)(?: (.*))?$/.exec(value);

    //not compressed
    if (!match) {
        return value;
    }

    //
    if (match[2] !== undefined) {
        table.set(match[1], match[2]);
        return match[2];
    }

    //
    return table.get(match[1]) ?? `(${match[1]})`;

}

//
function position(value, previous) {

    //
    if (value === '*') {
        return previous;
    }

    //
    if (value[0] === '+' || value[0] === '-') {
        return previous + Number(value);
    }

    //
    return Number(value);

}

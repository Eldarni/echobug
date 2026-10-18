
//binary units (1 KB = 1024 B) with two decimals, whole bytes below a kilobyte - profiles can report memory being freed,
//so a negative size is scaled the same as a positive one
export function formatBytes(bytes) {

    //
    const units = ['TB', 'GB', 'MB', 'KB'];
    for (const [index, unit] of units.entries()) {
        const scale = 1024 ** (units.length - index);
        if (Math.abs(bytes) >= scale) {
            return `${(bytes / scale).toFixed(2)} ${unit}`;
        }
    }

    //
    return `${bytes} B`;

}

//
export function formatUrl(url) {
    try {
        return [(new URL(url)).pathname, url];
    } catch (err) {
        return [url, url];
    }
}

//timestamps arrive as utc epoch microseconds, and are shown in local time
export function formatTimestamp(timestamp, withMilliseconds = false) {

    //
    const date = new Date(timestamp / 1000);

    //
    if (timestamp === null || timestamp === undefined || isNaN(date)) {
        return '';
    }

    //
    return date.toLocaleTimeString('en-GB', {
        hour12                 : false,
        hour                   : '2-digit',
        minute                 : '2-digit',
        second                 : '2-digit',
        fractionalSecondDigits : withMilliseconds ? 3 : undefined,
    });

}

//values can be anything that json allows, so make sure they are all readable
export function formatValue(value) {

    //
    if (value === null || value === undefined) {
        return 'null';
    }

    //
    if (typeof value === 'object') {
        return JSON.stringify(value);
    }

    //
    return String(value);

}

//whether a string holds a json object or array - those are shown pretty printed and highlighted
export function isJsonString(value) {
    try {
        const json = JSON.parse(value);
        return (typeof json === 'object' && json !== null);
    } catch (err) {
        return false;
    }
}

//
export function syntaxHighlightJSON(json) {

    //
    json = JSON.stringify(JSON.parse(json), null, 4);

    //
    json = json.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');

    //
    return { _isSafe: true, toString: () => json.replace(/("(\\u[a-zA-Z0-9]{4}|\\[^u]|[^\\"])*"(\s*:)?|\b(true|false|null)\b|-?\d+(?:\.\d+)?(?:[eE][+\-]?\d+)?)/g, function (match) {

        //
        let type = 'number';

        //
        if (/^"/.test(match)) {
            if (/:$/.test(match)) {
                type = 'key';
            } else {
                type = 'string';
            }
        } else if (/true|false/.test(match)) {
            type = 'boolean';
        } else if (/null/.test(match)) {
            type = 'null';
        }

        //
        return `<span class="${type}">${match}</span>`;

    })};

}


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

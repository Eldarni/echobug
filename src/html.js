
//simple xss safe template literal - makes certain assumptions around the formatting - but it works for my use case
export function html(strings, ...values) {

    //
    const escapeHTML = (str) => {
        return String(str ?? '')
            .replace(/&/g, "&amp;")
            .replace(/</g, "&lt;")
            .replace(/>/g, "&gt;")
            .replace(/"/g, "&quot;")
            .replace(/'/g, "&#x27;")
            .replace(/\//g, "&#x2F;");
    }

    //
    const escapeHTMLAttr = (str) => {
        return escapeHTML(str)
            .replace(/`/g, "&#x60;")
            .replace(/=/g, "&#x3D;");
    }

    //
    const escapeURL = (str) => {
        return encodeURIComponent(String(str ?? ''));
    }

    //
    let result = '';

    //
    let inAttr = false;
    let currentAttrName = null;

    //
    for (let i = 0; i < strings.length; i++) {

        //
        result += strings[i];

        //scan chunk for entering/exiting attribute values
        for (let j = 0; j < strings[i].length; j++) {
            if (!inAttr) {
                const attrMatch = strings[i].slice(0, j+1).match(/([^\s=]+)\s*=\s*"$/);
                if (attrMatch) {
                    inAttr = true;
                    currentAttrName = attrMatch[1].toLowerCase();
                }
            } else {
                if (strings[i][j] === '"') {
                    inAttr = false;
                    currentAttrName = null;
                }
            }
        }

        //
        if (i < values.length) {
            ((Array.isArray(values[i])) ? values[i] : [values[i]]).forEach((value) => {

                //
                if (typeof value === 'object' && value?._isSafe === true) {
                    result += value.toString();
                    return;
                }

                //
                if (inAttr) {
                    if (['href', 'src'].includes(currentAttrName)) {
                        result += escapeURL(value);
                    } else {
                        result += escapeHTMLAttr(value);
                    }
                } else {
                    result += escapeHTML(value);
                }

            });
        }
    }

    //
    return {
        _isSafe: true,
        toString: () => result,
    };

}

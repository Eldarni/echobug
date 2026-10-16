
//
import { html } from './html.js';
import { formatValue } from './format.js';

//sections of key/value pairs shown as one table, each section with a header that collapses it - used for the request
//context and for the context of an exception, so the two look the same
export function contextTableHtml(sections) {
    return html`
        <table class="context-table">
            ${sections.map(({ key, label, rows }) => html`
                <thead data-context-key="${key}">
                    <tr>
                        <th colspan="2">
                            <div>
                                <span class="arrow">▼</span>
                                <span class="label">${label}</span>
                                <span class="count">${rows.length}</span>
                            </div>
                        </th>
                    </tr>
                </thead>
                <tbody data-context-key="${key}">
                    ${rows.map(([ name, value ]) => html`
                        <tr>
                            <td>${name}</td>
                            <td>${formatValue(value)}</td>
                        </tr>
                    `)}
                </tbody>
            `)}
        </table>
    `;
}

//the sections the user has collapsed are kept in the set, so they stay collapsed when the table is rendered again -
//while filtering everything is expanded, so that no matches are hidden
export function initializeContextTable(container, collapsedSections, isFiltering = false) {
    container.querySelectorAll('.context-table thead').forEach((header) => {

        //
        const key = header.dataset.contextKey;
        const body = header.nextElementSibling;
        const arrow = header.querySelector('.arrow');

        //
        const setCollapsed = (isCollapsed) => {
            body.style.display = (isCollapsed) ? 'none' : '';
            arrow.textContent = (isCollapsed) ? '▶' : '▼';
        };

        //
        if (!isFiltering && collapsedSections.has(key)) {
            setCollapsed(true);
        }

        //
        header.addEventListener('click', function() {

            //
            const isCollapsed = body.style.display !== 'none';

            //
            setCollapsed(isCollapsed);

            //
            if (isCollapsed) {
                collapsedSections.add(key);
            } else {
                collapsedSections.delete(key);
            }

        });

    });
}

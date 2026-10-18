
//
const { invoke } = window.__TAURI__.core;
const { listen } = window.__TAURI__.event;

//bars along the bottom of the main window, the newest closest to the bottom
const container = document.querySelector('.alerts');

//alerts can come from rust too, in the same shape - their actions can only be commands
listen('alert-show', (event) => {
    showAlert(event.payload);
});

//
listen('alert-hide', (event) => {
    hideAlert(event.payload.id);
});

//level is info, warn or error - each action either calls onClick or invokes a command with args, and hides the alert
//once clicked if dismiss is set. Showing an alert with the id of one that is already showing replaces it in place
export function showAlert({ id, level = 'info', text, title, actions = [] }) {

    //
    const alert = document.createElement('div');
    alert.className = 'alert';
    alert.dataset.id = id;
    alert.dataset.level = level;

    //the text can come from anywhere, so it is only ever text
    const message = document.createElement('span');
    message.className = 'message';
    message.textContent = text;
    message.title = title ?? '';
    alert.append(message);

    //
    for (const action of actions ?? []) {
        const button = document.createElement('button');
        button.className = 'action';
        button.textContent = action.label;
        button.addEventListener('click', () => runAction(id, action));
        alert.append(button);
    }

    //
    const dismiss = document.createElement('button');
    dismiss.className = 'dismiss';
    dismiss.title = 'Dismiss';
    dismiss.textContent = '×';
    dismiss.addEventListener('click', () => hideAlert(id));
    alert.append(dismiss);

    //
    const existing = findAlert(id);
    if (existing) {
        existing.replaceWith(alert);
    } else {
        container.append(alert);
    }

}

//
export function hideAlert(id) {
    findAlert(id)?.remove();
}

//
function findAlert(id) {
    return container.querySelector(`.alert[data-id="${CSS.escape(id)}"]`);
}

//
function runAction(id, action) {

    //
    if (action.dismiss) {
        hideAlert(id);
    }

    //
    if (action.onClick) {
        action.onClick();
        return;
    }

    //
    invoke(action.command, action.args ?? {}).catch((error) => {
        console.error(`[echobug] ${action.command} failed:`, error);
    });

}


//
const { invoke } = window.__TAURI__.core;

//
const form   = document.querySelector('form');
const port   = form.querySelector('[name="port"]');
const host   = form.querySelector('[name="host"]');
const status = form.querySelector('.status');

//
function showStatus(serverStatus) {
    status.classList.toggle('error', Boolean(serverStatus.error));
    status.textContent = (serverStatus.error)
        ? `unable to listen on ${serverStatus.host}:${serverStatus.port}: ${serverStatus.error}`
        : `listening on ${serverStatus.host}:${serverStatus.port}`;
}

//
invoke('get_settings').then((settings) => {
    port.value = settings.port;
    host.value = settings.host;
});

//
invoke('get_server_status').then(showStatus);

//
form.addEventListener('submit', function(event) {

    //
    event.preventDefault();

    //
    invoke('save_settings', { settings: { port: Number(port.value), host: host.value } }).then(showStatus).catch((error) => {
        status.classList.add('error');
        status.textContent = String(error);
    });

});

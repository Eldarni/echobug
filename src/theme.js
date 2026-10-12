
// loaded as a plain script in the head of every page, so the theme is set before the first paint
(function() {

    //
    const STORAGE_KEY = 'echobug-theme';
    const prefersDark = window.matchMedia('(prefers-color-scheme: dark)');

    //
    let setting = localStorage.getItem(STORAGE_KEY) || 'system';

    //
    function resolve() {
        if (setting === 'light' || setting === 'dark') {
            return setting;
        }
        return prefersDark.matches ? 'dark' : 'light';
    }

    //
    function apply() {
        const theme = resolve();
        if (document.documentElement.dataset.theme === theme) {
            return;
        }
        document.documentElement.dataset.theme = theme;
        document.dispatchEvent(new CustomEvent('themechange', { detail: { theme } }));
    }

    //
    function update(value) {
        setting = value || 'system';
        localStorage.setItem(STORAGE_KEY, setting);
        apply();
    }

    //
    apply();

    //
    prefersDark.addEventListener('change', apply);

    //
    const tauri = window.__TAURI__;
    if (tauri) {
        tauri.core.invoke('get_settings').then((settings) => update(settings.theme));
        tauri.event.listen('theme-changed', (event) => update(event.payload));
    }

})();

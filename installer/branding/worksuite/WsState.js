// Installer choices shared between pages. Each Calamares page has its own QML engine and Global storage is
// read-only from QML, so the state lives in a small file in /run (the live launcher allows QML file access).
.pragma library
var path = "file:///run/worksuite-installer.json"

function read() {
    try {
        var x = new XMLHttpRequest()
        x.open("GET", path, false); x.send()
        return x.responseText ? JSON.parse(x.responseText) : {}
    } catch (e) { return {} }
}
function write(state) {
    try { var x = new XMLHttpRequest(); x.open("PUT", path, false); x.send(JSON.stringify(state)) } catch (e) {}
}
function set(key, value) { var s = read(); s[key] = value; write(s) }
function get(key, fallback) { var s = read(); return key in s ? s[key] : fallback }

// The WorkSuite loader ("assemble") for the installer's pages: the same keyframes as the boot splash
// (branding/plymouth/worksuite.script), the greeter (worksuite_greeter/loader.py) and the shell, on the SVG's
// 128-unit grid. Plays only while `running`; reduced motion (or not running) shows the assembled mark.
import QtQuick 2.15

Item {
    id: root
    property bool running: true
    property real size: 20
    width: size; height: size
    property real t: 0.5
    readonly property real k: size / 128

    NumberAnimation on t { from: 0; to: 1; duration: 2400; loops: Animation.Infinite; running: root.running && root.visible }
    onRunningChanged: if (!running) t = 0.5

    function ease(x) { return x * x * x * (x * (x * 6 - 15) + 10) }
    function kf(t, f) {
        if (t <= f[0][0]) return f[0][1]
        for (var i = 1; i < f.length; ++i)
            if (t <= f[i][0]) return f[i][0] === f[i - 1][0] ? f[i][1] : f[i - 1][1] + (f[i][1] - f[i - 1][1]) * ease((t - f[i - 1][0]) / (f[i][0] - f[i - 1][0]))
        return f[f.length - 1][1]
    }
    readonly property var leftKeys: [[0, 1], [0.14, 0], [0.70, 0], [0.86, 1], [1, 1]]
    readonly property var bottomKeys: [[0, 1], [0.08, 1], [0.22, 0], [0.74, 0], [0.90, 1], [1, 1]]
    readonly property var blueKeys: [[0, 0], [0.16, 0], [0.32, 1.06], [0.38, 1], [0.66, 1], [0.82, 0], [1, 0]]
    readonly property var navyKeys: [[0, 0], [0.34, 0], [0.44, 1], [0.62, 1], [0.72, 0], [1, 0]]
    readonly property real offL: kf(t, leftKeys)
    readonly property real offB: kf(t, bottomKeys)
    readonly property real sQ: kf(t, blueKeys)
    readonly property real sN: kf(t, navyKeys)

    Rectangle { color: "#00daf2"; x: (16 - 28 * root.offL) * root.k; y: 48 * root.k; width: 32 * root.k; height: width; opacity: 1 - root.offL }
    Rectangle { color: "#00daf2"; x: 48 * root.k; y: (80 + 28 * root.offB) * root.k; width: 32 * root.k; height: width; opacity: 1 - root.offB }
    Rectangle { color: "#0a6cff"; visible: root.sQ > 0.001; x: (112 - 64 * root.sQ) * root.k; y: 16 * root.k; width: 64 * root.sQ * root.k; height: width; opacity: Math.min(1, root.sQ) }
    Rectangle { color: "#001842"; visible: root.sN > 0.001; x: (64 - 16 * root.sN) * root.k; y: (64 - 16 * root.sN) * root.k; width: 32 * root.sN * root.k; height: width; opacity: root.sN }
}

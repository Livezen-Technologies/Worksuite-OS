// Check mark drawn as a vector path (the same 14×14 geometry as check.svg), so it never depends on a font having the
// ✓ glyph: IBM Plex has none, and the fallback rendered it like a square-root sign. Use it wherever a check is shown.
import QtQuick 2.15
Canvas {
    id: root
    property color color: "#FFFFFF"
    property real lineWidth: 2
    property int size: 14
    width: size; height: size
    antialiasing: true
    onColorChanged: requestPaint()
    onLineWidthChanged: requestPaint()
    onPaint: {
        var ctx = getContext("2d"); var s = width / 14
        ctx.reset()
        ctx.strokeStyle = root.color; ctx.lineWidth = root.lineWidth * s
        ctx.lineCap = "round"; ctx.lineJoin = "round"
        ctx.beginPath(); ctx.moveTo(2.5 * s, 7.4 * s); ctx.lineTo(5.4 * s, 10.3 * s); ctx.lineTo(11.4 * s, 4 * s); ctx.stroke()
    }
}

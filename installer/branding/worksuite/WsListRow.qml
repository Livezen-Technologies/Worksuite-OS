/* A selectable row in a card list: blue when selected. */
import QtQuick 2.15
import QtQuick.Layouts 1.15

Rectangle {
    id: row
    property string text
    property string detail
    property bool selected: false
    signal picked()
    implicitHeight: 42
    radius: 8
    color: selected ? "#1F6BFF" : mouse.containsMouse ? "#147FB2FF" : "transparent"
    RowLayout {
        anchors.fill: parent; anchors.leftMargin: 14; anchors.rightMargin: 14
        Text { Layout.fillWidth: true; text: row.text; color: row.selected ? "#FFFFFF" : "#E8EEFA"; font.family: "IBM Plex Sans"; font.pixelSize: 14; elide: Text.ElideRight }
        Text { text: row.detail; color: row.selected ? "#FFFFFF" : "#8FA3C8"; font.family: "IBM Plex Sans"; font.pixelSize: 13; visible: text !== "" }
    }
    MouseArea { id: mouse; anchors.fill: parent; hoverEnabled: true; cursorShape: Qt.PointingHandCursor; onClicked: row.picked() }
}

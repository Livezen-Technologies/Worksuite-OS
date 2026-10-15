/* A large selectable option card (Express / Custom). */
import QtQuick 2.15
import QtQuick.Layouts 1.15

Rectangle {
    id: c
    property string title
    property string text
    property string badge
    property bool selected: false
    signal picked()
    implicitHeight: col.implicitHeight + 36
    radius: 12
    color: selected ? "#2E1F6BFF" : "#990E2048"
    border.width: selected ? 2 : 1
    border.color: selected ? "#1F6BFF" : mouse.containsMouse ? "#557FB2FF" : "#297FB2FF"
    RowLayout {
        anchors.fill: parent; anchors.margins: 18
        spacing: 14
        Rectangle {
            Layout.alignment: Qt.AlignTop
            width: 20; height: 20; radius: 10; color: "transparent"
            border.width: 2; border.color: c.selected ? "#1F6BFF" : "#5E739C"
            Rectangle { anchors.centerIn: parent; width: 10; height: 10; radius: 5; color: "#1F6BFF"; visible: c.selected }
        }
        ColumnLayout {
            id: col
            Layout.fillWidth: true
            spacing: 6
            RowLayout {
                spacing: 10
                Text { text: c.title; color: "#E8EEFA"; font.family: "IBM Plex Sans"; font.pixelSize: 16; font.weight: Font.DemiBold }
                Rectangle {
                    visible: c.badge !== ""
                    radius: 6; color: "#2618D4F0"; implicitWidth: b.implicitWidth + 14; implicitHeight: 20
                    Text { id: b; anchors.centerIn: parent; text: c.badge; color: "#18D4F0"; font.family: "IBM Plex Mono"; font.pixelSize: 11 }
                }
            }
            Text { Layout.fillWidth: true; text: c.text; color: "#8FA3C8"; font.family: "IBM Plex Sans"; font.pixelSize: 13; wrapMode: Text.WordWrap; lineHeight: 1.25 }
        }
    }
    MouseArea { id: mouse; anchors.fill: parent; hoverEnabled: true; cursorShape: Qt.PointingHandCursor; onClicked: c.picked() }
}

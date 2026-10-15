/* The design's 44 px input. */
import QtQuick 2.15
import QtQuick.Controls.Basic 2.15

TextField {
    property bool mono: false
    property bool invalid: false
    implicitHeight: 44
    leftPadding: 14; rightPadding: 14
    color: "#E8EEFA"
    placeholderTextColor: "#5E739C"
    selectionColor: "#1F6BFF"
    font.family: mono ? "IBM Plex Mono" : "IBM Plex Sans"; font.pixelSize: 14
    passwordCharacter: "●"
    background: Rectangle {
        radius: 10
        color: "#800A1A3D"
        border.width: 1
        border.color: parent.invalid ? "#FF9F5A" : parent.activeFocus ? "#7FB2FF" : "#337FB2FF"
    }
}

/* Step 1 · Keyboard (design: Installer sub-steps › 1 · Keyboard). Custom install only; Express passes over it. */
import io.calamares.core 1.0
import io.calamares.ui 1.0
import QtQuick 2.15
import QtQuick.Layouts 1.15

WsPage {
    id: page
    eyebrow: qsTr("Step 1 · Keyboard")
    title: qsTr("Keyboard layout")
    subtitle: qsTr("Pick your layout, then type in the box below: the keys you press light up.")
    skipInExpress: true
    function onActivate() { arrive() }
    function onLeave() { leave() }

    readonly property var rows: ["QWERTYUIOP", "ASDFGHJKL", "ZXCVBNM"]
    readonly property string typed: test.text.toUpperCase()

    ColumnLayout {
        anchors.fill: parent
        spacing: 20

        RowLayout {
            Layout.fillWidth: true
            spacing: 16
            ColumnLayout {
                Layout.fillWidth: true; Layout.preferredWidth: 1; spacing: 6
                WsLabel { text: qsTr("Layout") }
                WsCombo {
                    Layout.fillWidth: true
                    model: config.keyboardLayoutsModel; textRole: "label"
                    currentIndex: config.keyboardLayoutsModel.currentIndex
                    onActivated: function (i) { config.keyboardLayoutsModel.currentIndex = i }
                }
            }
            ColumnLayout {
                Layout.fillWidth: true; Layout.preferredWidth: 1; spacing: 6
                WsLabel { text: qsTr("Variant") }
                WsCombo {
                    Layout.fillWidth: true
                    model: config.keyboardVariantsModel; textRole: "label"
                    currentIndex: config.keyboardVariantsModel.currentIndex
                    onActivated: function (i) { config.keyboardVariantsModel.currentIndex = i }
                }
            }
        }

        // The design's keyboard: keys typed in the test box light up.
        Rectangle {
            Layout.fillWidth: true
            implicitHeight: keys.implicitHeight + 36
            radius: 14; color: "#73040A1A"; border.width: 1; border.color: "#247FB2FF"
            Column {
                id: keys
                anchors.centerIn: parent
                spacing: 6
                Repeater {
                    model: page.rows
                    Row {
                        spacing: 6
                        leftPadding: index * 24
                        Repeater {
                            model: modelData.split("")
                            Rectangle {
                                readonly property bool lit: page.typed.indexOf(modelData) >= 0
                                width: 44; height: 44; radius: 7
                                color: lit ? "#1F6BFF" : "#CC0E2048"; border.width: 1; border.color: "#297FB2FF"
                                Text { anchors.centerIn: parent; text: modelData; color: parent.lit ? "#FFFFFF" : "#C9D6EE"; font.family: "IBM Plex Mono"; font.pixelSize: 14 }
                            }
                        }
                    }
                }
                Rectangle {
                    anchors.horizontalCenter: parent.horizontalCenter
                    width: 320; height: 44; radius: 7
                    color: page.typed.indexOf(" ") >= 0 ? "#1F6BFF" : "#CC0E2048"; border.width: 1; border.color: "#297FB2FF"
                    Text { anchors.centerIn: parent; text: qsTr("space"); color: "#8FA3C8"; font.family: "IBM Plex Mono"; font.pixelSize: 14 }
                }
            }
        }

        ColumnLayout {
            Layout.fillWidth: true; spacing: 6
            WsLabel { text: qsTr("Test your keyboard") }
            WsField { id: test; Layout.fillWidth: true; placeholderText: qsTr("Type here — keys light up above") }
        }
        Item { Layout.fillHeight: true }
    }
}

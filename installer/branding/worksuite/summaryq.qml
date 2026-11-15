/* Step 5 · Summary (design: Installer sub-steps › 5 · Summary). One card per step's summary; the disk is erased only
   after the typed confirmation on the next page (worksuiteconfirm@erase). */
import io.calamares.core 1.0
import io.calamares.ui 1.0
import QtQuick 2.15
import QtQuick.Layouts 1.15

WsPage {
    stepIndex: 6
    eyebrow: qsTr("Step 5 · Summary")
    title: qsTr("Check your choices")
    subtitle: qsTr("Nothing has changed on your disk yet.")

    // Cards size to their text: the partition summary (erase, encryption, layout) is never cut off with "…".
    Flickable {
        id: scroller
        anchors.fill: parent
        clip: true
        contentWidth: width; contentHeight: grid.implicitHeight
        boundsBehavior: Flickable.StopAtBounds
        GridLayout {
            id: grid
            width: scroller.width
            columns: width > 720 ? 2 : 1
            columnSpacing: 12; rowSpacing: 12
            Repeater {
                model: config.summaryModel
                delegate: Rectangle {
                    Layout.fillWidth: true; Layout.alignment: Qt.AlignTop
                    Layout.preferredWidth: (grid.width - (grid.columns - 1) * grid.columnSpacing) / grid.columns
                    implicitHeight: row.implicitHeight + 32
                    radius: 12; color: "#990E2048"; border.width: 1; border.color: "#247FB2FF"
                    RowLayout {
                        id: row
                        anchors.left: parent.left; anchors.right: parent.right; anchors.top: parent.top; anchors.margins: 16; spacing: 14
                        Rectangle {
                            Layout.alignment: Qt.AlignTop
                            width: 36; height: 36; radius: 9; color: "#2E1F6BFF"
                            Text { anchors.centerIn: parent; text: String(index + 1); color: "#7FB2FF"; font.family: "IBM Plex Mono"; font.pixelSize: 14; font.weight: Font.DemiBold }
                        }
                        ColumnLayout {
                            Layout.fillWidth: true; Layout.alignment: Qt.AlignTop; spacing: 3
                            Text { text: model.title.toUpperCase(); color: "#8FA3C8"; font.family: "IBM Plex Sans"; font.pixelSize: 12; font.letterSpacing: 0.7 }
                            Text {
                                Layout.fillWidth: true
                                text: model.message; textFormat: Text.StyledText
                                color: "#E8EEFA"; font.family: "IBM Plex Sans"; font.pixelSize: 14; lineHeight: 1.15
                                wrapMode: Text.Wrap
                            }
                        }
                    }
                }
            }
        }
    }
}

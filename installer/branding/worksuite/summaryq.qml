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

    GridView {
        id: cards
        anchors.fill: parent
        clip: true
        cellWidth: width / 2; cellHeight: 112
        model: config.summaryModel
        delegate: Item {
            width: cards.cellWidth; height: cards.cellHeight
            Rectangle {
                anchors.fill: parent; anchors.rightMargin: index % 2 === 0 ? 6 : 0; anchors.leftMargin: index % 2 === 1 ? 6 : 0; anchors.bottomMargin: 12
                radius: 12; color: "#990E2048"; border.width: 1; border.color: "#247FB2FF"
                RowLayout {
                    anchors.fill: parent; anchors.margins: 16; spacing: 14
                    Rectangle {
                        Layout.alignment: Qt.AlignTop
                        width: 36; height: 36; radius: 9; color: "#2E1F6BFF"
                        Text { anchors.centerIn: parent; text: String(index + 1); color: "#7FB2FF"; font.family: "IBM Plex Mono"; font.pixelSize: 14; font.weight: Font.DemiBold }
                    }
                    ColumnLayout {
                        Layout.fillWidth: true; Layout.fillHeight: true; spacing: 3
                        Text { text: model.title.toUpperCase(); color: "#8FA3C8"; font.family: "IBM Plex Sans"; font.pixelSize: 12; font.letterSpacing: 0.7 }
                        Text {
                            Layout.fillWidth: true; Layout.fillHeight: true
                            text: model.message; textFormat: Text.StyledText
                            color: "#E8EEFA"; font.family: "IBM Plex Sans"; font.pixelSize: 14
                            wrapMode: Text.WordWrap; elide: Text.ElideRight; clip: true
                        }
                    }
                }
            }
        }
    }
}

/* Step 4 (design: Installer › Time zone). Express keeps the default time zone and passes over it. */
import io.calamares.core 1.0
import io.calamares.ui 1.0
import QtQuick 2.15
import QtQuick.Layouts 1.15
import QtQuick.Controls.Basic 2.15

WsPage {
    id: page
    step: 4
    title: qsTr("Where are you?")
    subtitle: qsTr("Pick your region and city. The clock and date formats follow it.")
    skipInExpress: true
    property string region: config.currentLocation ? config.currentLocation.region : ""
    function onActivate() {
        config.regionalZonesModel.region = region
        arrive()
    }

    ColumnLayout {
        anchors.fill: parent
        spacing: 20

        // Dotted world panel with the selected place (the design's map, without geographic projection).
        Rectangle {
            Layout.fillWidth: true; Layout.preferredHeight: 230
            radius: 14; clip: true; color: "#081634"; border.width: 1; border.color: "#297FB2FF"
            Canvas {
                anchors.fill: parent
                onPaint: {
                    var c = getContext("2d"); c.fillStyle = "rgba(127,178,255,0.22)"
                    for (var x = 7; x < width; x += 14) for (var y = 7; y < height; y += 14) { c.beginPath(); c.arc(x, y, 1.2, 0, 2 * Math.PI); c.fill() }
                }
            }
            Rectangle { id: band; x: parent.width * 0.62; width: 46; height: parent.height; color: "#2418D4F0"; border.width: 1; border.color: "#6618D4F0" }
            Rectangle {
                id: dot
                x: band.x + 15; y: parent.height / 2 - 8; width: 16; height: 16; radius: 8; color: "#18D4F0"
                Rectangle { anchors.centerIn: parent; width: 28; height: 28; radius: 14; color: "#4018D4F0"; z: -1 }
            }
            Rectangle {
                x: band.x + 44; y: dot.y - 16
                radius: 8; color: "#D9040A1A"; border.width: 1; border.color: "#337FB2FF"
                implicitWidth: tag.implicitWidth + 24; implicitHeight: tag.implicitHeight + 16
                Column {
                    id: tag; anchors.centerIn: parent; spacing: 2
                    Text { text: config.currentLocation ? config.currentLocation.name : ""; color: "#E8EEFA"; font.family: "IBM Plex Sans"; font.pixelSize: 14; font.weight: Font.DemiBold }
                    Text { text: config.currentTimezoneName; color: "#8FA3C8"; font.family: "IBM Plex Mono"; font.pixelSize: 12 }
                }
            }
        }

        RowLayout {
            Layout.fillWidth: true; Layout.fillHeight: true
            spacing: 16
            ColumnLayout {
                Layout.fillWidth: true; Layout.fillHeight: true; Layout.preferredWidth: 1; spacing: 8
                WsLabel { text: qsTr("Region") }
                WsCard {
                    Layout.fillWidth: true; Layout.fillHeight: true
                    ListView {
                        anchors.fill: parent; anchors.margins: 6; clip: true; spacing: 2
                        model: config.regionModel
                        delegate: WsListRow {
                            width: ListView.view.width
                            text: model.name
                            selected: model.key === page.region
                            onPicked: { page.region = model.key; config.regionalZonesModel.region = model.key }
                        }
                    }
                }
            }
            ColumnLayout {
                Layout.fillWidth: true; Layout.fillHeight: true; Layout.preferredWidth: 1; spacing: 8
                WsLabel { text: qsTr("City") }
                WsCard {
                    Layout.fillWidth: true; Layout.fillHeight: true
                    ListView {
                        id: zones
                        anchors.fill: parent; anchors.margins: 6; clip: true; spacing: 2
                        model: config.regionalZonesModel
                        delegate: WsListRow {
                            width: ListView.view.width
                            text: model.name
                            selected: config.currentLocation && config.currentLocation.region === page.region && config.currentLocation.zone === model.key
                            onPicked: config.setCurrentLocation(page.region, model.key)
                        }
                    }
                }
            }
        }
    }
}

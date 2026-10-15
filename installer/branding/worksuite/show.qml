/* Step 6 · Copy files, then Configure system (design: Installer sub-steps › 6 · Copy files, 6 · Configure system).
   The stage comes from the worksuitephase markers in settings.conf ("worksuitePhase" in global storage). Calamares
   does not pass job progress or byte counts to the slideshow: its own progress bar and current-job line sit under
   this page (stylesheet.qss #exec-progress, #exec-message), so this page shows only what it can know: the stage,
   which configure tasks have finished and how long each took, and the elapsed time. */
import QtQuick 2.15
import QtQuick.Layouts 1.15
import io.calamares.core 1.0
import calamares.slideshow 1.0

Presentation {
    id: presentation

    // "prepare" (partitioning), then "copy" (unpacking), then the configure task under way.
    property string phase: "prepare"
    readonly property var tasks: [
        ["locale", qsTr("Set language, keyboard and time zone")],
        ["unlock", qsTr("Set up disk unlocking")],
        ["account", qsTr("Create your account and computer name")],
        ["components", qsTr("Install WorkSuite components")],
        ["boot", qsTr("Install bootloader")],
        ["cleanup", qsTr("Clean up")]
    ]
    property var finishedAt: ({})     // task id → seconds it took
    property real started: 0
    property real phaseStarted: 0
    property int elapsed: 0
    readonly property bool copying: phase === "prepare" || phase === "copy" || phase === ""
    readonly property bool preparing: phase === "prepare" || phase === ""
    property WsState wsState: WsState {}
    readonly property int current: { for (var i = 0; i < tasks.length; i++) if (tasks[i][0] === phase) return i; return -1 }
    // Global storage has no change signal: poll() re-reads the real state. worksuiteEncrypted is recorded from the
    // partition page's Encrypt box and the planned jobs (worksuiteconfirm); "partitions" once the partition job ran.
    property bool encrypted: false
    function readEncrypted() {
        if (Global.value("worksuiteEncrypted") === true || wsState.get("encrypt", false) === true) return true
        var parts = Global.value("partitions")
        if (!parts) return false
        for (var i = 0; i < parts.length; i++) if (parts[i].luksMapperName || parts[i].fs === "luks" || parts[i].fs === "luks2") return true
        return false
    }

    function clock(s) { var m = Math.floor(s / 60); var r = s % 60; return m + ":" + (r < 10 ? "0" : "") + r }
    function poll() {
        var now = Date.now()
        if (!started) { started = now; phaseStarted = now }
        elapsed = Math.floor((now - started) / 1000)
        encrypted = readEncrypted()
        var p = Global.value("worksuitePhase") || "prepare"
        if (p === phase) return
        if (current >= 0) {
            var f = Object.assign({}, finishedAt)
            f[phase] = Math.max(1, Math.round((now - phaseStarted) / 1000))
            finishedAt = f
        }
        phaseStarted = now
        phase = p
    }
    Timer { interval: 500; repeat: true; running: true; triggeredOnStart: true; onTriggered: presentation.poll() }

    Slide {
        // Calamares' Slide sits at 90% x 70% of the view, leaving the view's white clear colour around it: fill it.
        anchors.fill: parent
        // Rendered at its on-screen size, so the background is never scaled.
        Image { anchors.fill: parent; source: "page-bg.svg"; sourceSize: Qt.size(Math.max(1, width), Math.max(1, height)); smooth: false; cache: false }
        ColumnLayout {
            anchors.fill: parent
            anchors.leftMargin: 56; anchors.rightMargin: 56; anchors.topMargin: 40; anchors.bottomMargin: 16
            spacing: 26
            ColumnLayout {
                spacing: 6
                Text { text: presentation.copying ? qsTr("STEP 6 · COPY FILES") : qsTr("STEP 6 · CONFIGURE SYSTEM"); color: "#18D4F0"; font.family: "IBM Plex Mono"; font.pixelSize: 12; font.letterSpacing: 1 }
                Text { text: presentation.copying ? qsTr("Copying WorkSuite OS") : qsTr("Setting things up"); color: "#E8EEFA"; font.family: "IBM Plex Sans"; font.pixelSize: 30; font.weight: Font.Bold; font.letterSpacing: -0.6 }
                Text {
                    Layout.fillWidth: true; wrapMode: Text.WordWrap
                    text: presentation.copying ? qsTr("Keep the computer plugged in. You can't go back from here.") : qsTr("Applying your choices. This usually takes under a minute.")
                    color: "#8FA3C8"; font.family: "IBM Plex Sans"; font.pixelSize: 15
                }
            }

            // 6 · Copy files: the stage card (the percentage is Calamares' bar below) and the stats this page knows.
            Rectangle {
                visible: presentation.copying
                Layout.fillWidth: true
                implicitHeight: copyCol.implicitHeight + 48
                radius: 16; color: "#990E2048"; border.width: 1; border.color: "#247FB2FF"
                ColumnLayout {
                    id: copyCol
                    anchors.fill: parent; anchors.margins: 24
                    spacing: 14
                    Text { text: presentation.preparing ? qsTr("Preparing the disk") : qsTr("Unpacking system image"); color: "#E8EEFA"; font.family: "IBM Plex Sans"; font.pixelSize: 15; font.weight: Font.Medium }
                    // Indeterminate: a light sweeping along the track; the real percentage is the bar under this page.
                    Rectangle {
                        Layout.fillWidth: true; height: 10; radius: 5; color: "#1F7FB2FF"; clip: true
                        Rectangle {
                            id: sweep
                            width: parent.width * 0.4; height: parent.height; radius: 5
                            gradient: Gradient { orientation: Gradient.Horizontal; GradientStop { position: 0; color: "#001F6BFF" } GradientStop { position: 0.5; color: "#18D4F0" } GradientStop { position: 1; color: "#001F6BFF" } }
                            NumberAnimation on x { from: -sweep.width; to: sweep.parent.width; duration: 1800; loops: Animation.Infinite; running: presentation.copying }
                        }
                    }
                    Text { text: qsTr("Progress and the file being copied are shown at the bottom of the window."); color: "#8FA3C8"; font.family: "IBM Plex Mono"; font.pixelSize: 12 }
                }
            }
            GridLayout {
                visible: presentation.copying
                Layout.fillWidth: true
                columns: 3; columnSpacing: 12
                Repeater {
                    model: [
                        [qsTr("Elapsed"), presentation.clock(presentation.elapsed)],
                        [qsTr("Encryption"), presentation.encrypted ? qsTr("On") : qsTr("Off")],
                        [qsTr("Stage"), qsTr("1 of 2")]
                    ]
                    Rectangle {
                        Layout.fillWidth: true; Layout.preferredWidth: 1
                        implicitHeight: 76; radius: 12; color: "#730E2048"; border.width: 1; border.color: "#1A7FB2FF"
                        ColumnLayout {
                            anchors.fill: parent; anchors.margins: 16; spacing: 4
                            Text { text: modelData[0]; color: "#8FA3C8"; font.family: "IBM Plex Sans"; font.pixelSize: 12 }
                            Text { text: modelData[1]; color: "#E8EEFA"; font.family: "IBM Plex Mono"; font.pixelSize: 18 }
                        }
                    }
                }
            }

            // 6 · Configure system: each task with done / active / waiting and the time it took.
            Rectangle {
                visible: !presentation.copying
                Layout.fillWidth: true
                implicitHeight: taskCol.implicitHeight + 16
                radius: 16; color: "#990E2048"; border.width: 1; border.color: "#247FB2FF"
                ColumnLayout {
                    id: taskCol
                    anchors.fill: parent; anchors.margins: 8
                    spacing: 0
                    Repeater {
                        model: presentation.tasks
                        Rectangle {
                            readonly property bool done: index < presentation.current
                            readonly property bool active: index === presentation.current
                            Layout.fillWidth: true; implicitHeight: 50; radius: 10
                            color: active ? "#141F6BFF" : "transparent"
                            RowLayout {
                                anchors.fill: parent; anchors.leftMargin: 16; anchors.rightMargin: 16; spacing: 14
                                Item {
                                    width: 22; height: 22
                                    Rectangle { anchors.fill: parent; radius: 11; visible: done; color: "#2E3DDC97"
                                        Text { anchors.centerIn: parent; text: "✓"; color: "#3DDC97"; font.pixelSize: 13; font.weight: Font.Bold } }
                                    Rectangle { anchors.fill: parent; radius: 11; visible: active; color: "transparent"; border.width: 2; border.color: "#2E7FB2FF"
                                        Rectangle { width: 22; height: 22; radius: 11; color: "transparent"; border.width: 2; border.color: "#18D4F0"; visible: active
                                            Rectangle { width: 12; height: 12; x: 10; y: -1; color: "#0E2048" }
                                            RotationAnimation on rotation { from: 0; to: 360; duration: 900; loops: Animation.Infinite; running: active } } }
                                    Rectangle { anchors.centerIn: parent; width: 8; height: 8; radius: 4; visible: !done && !active; color: "#5E739C" }
                                }
                                Text {
                                    Layout.fillWidth: true; text: modelData[1]; elide: Text.ElideRight
                                    color: done ? "#C9D6EE" : active ? "#FFFFFF" : "#5E739C"
                                    font.family: "IBM Plex Sans"; font.pixelSize: 15; font.weight: active ? Font.DemiBold : Font.Normal
                                }
                                Text {
                                    text: done && presentation.finishedAt[modelData[0]] ? presentation.clock(presentation.finishedAt[modelData[0]]) : ""
                                    color: "#8FA3C8"; font.family: "IBM Plex Mono"; font.pixelSize: 12
                                }
                            }
                        }
                    }
                }
            }
            Item { Layout.fillHeight: true }
            Text { Layout.alignment: Qt.AlignRight; text: qsTr("Do not turn off your computer"); color: "#8FA3C8"; font.family: "IBM Plex Sans"; font.pixelSize: 13 }
        }
    }
}

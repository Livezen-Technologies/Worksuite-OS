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
    property int phaseElapsed: 0      // seconds in the current configure task
    readonly property bool copying: phase === "prepare" || phase === "copy" || phase === ""
    readonly property bool preparing: phase === "prepare" || phase === ""
    property WsState wsState: WsState {}
    readonly property int current: { for (var i = 0; i < tasks.length; i++) if (tasks[i][0] === phase) return i; return -1 }
    // Global storage has no change signal: poll() re-reads the real state. worksuiteEncrypted is recorded from the
    // partition page's Encrypt box and the planned jobs (worksuiteconfirm); "partitions" once the partition job ran.
    property bool encrypted: false

    // Real progress, copied into global storage by worksuiteconfirm (reportProgress) from Calamares' job queue.
    property real progress: 0
    property real bytesDone: 0
    property real bytesTotal: 0
    property real filesDone: 0
    property real filesTotal: 0
    property real packagesDone: 0
    property real packagesTotal: 0
    property real imagePackages: 0    // packages in the system image being copied (counted at image build time)
    property var log: []
    property real speed: 0            // bytes per second over the last few seconds of samples
    property var samples: []          // [time ms, bytes]
    // Shown values count up to the real ones (the board's number tween).
    // While copying, the percentage is the copy's own (bytes written of the image's size), so it agrees with the GB
    // shown under the bar; it holds at 99 until the copy step ends. Otherwise the whole queue's progress.
    readonly property real copyFraction: bytesTotal > 0 && bytesDone > 0 ? Math.min(0.99, bytesDone / bytesTotal) : 0
    readonly property real shownFraction: copying && !preparing && bytesTotal > 0 ? copyFraction : progress
    property real shownPercent: shownFraction * 100
    Behavior on shownPercent { NumberAnimation { duration: 600; easing.type: Easing.OutCubic } }
    property real shownBytes: bytesDone
    Behavior on shownBytes { NumberAnimation { duration: 600; easing.type: Easing.OutCubic } }
    property real shownFiles: filesDone
    Behavior on shownFiles { NumberAnimation { duration: 600; easing.type: Easing.OutCubic } }
    property real shownPackages: packagesDone
    Behavior on shownPackages { NumberAnimation { duration: 600; easing.type: Easing.OutCubic } }
    function num(k) { var v = Number(Global.value(k)); return isFinite(v) ? v : 0 }
    function gb(b) { return (b / 1e9).toFixed(1) + " GB" }
    function rate(b) { return b >= 1e9 ? (b / 1e9).toFixed(1) + " GB/s" : Math.round(b / 1e6) + " MB/s" }
    function mmss(s) { var m = Math.floor(s / 60); var r = s % 60; return (m < 10 ? "0" : "") + m + ":" + (r < 10 ? "0" : "") + r }
    function timeLeft() {
        if (!(bytesTotal > 0 && speed > 0 && bytesDone > 0)) return ""
        var s = Math.max(0, bytesTotal - bytesDone) / speed
        return s < 60 ? qsTr("Less than a minute left") : qsTr("About %1 min left").arg(Math.round(s / 60))
    }
    function readProgress(now) {
        progress = Math.max(0, Math.min(1, num("worksuiteProgress")))
        bytesTotal = num("worksuiteBytesTotal")
        filesDone = num("worksuiteFilesDone"); filesTotal = num("worksuiteFilesTotal")
        packagesDone = num("worksuitePackagesDone"); packagesTotal = num("worksuitePackagesTotal")
        imagePackages = num("worksuiteImagePackages")
        var l = Global.value("worksuiteLog"); if (l && l.length !== log.length) log = l
        var b = num("worksuiteBytesDone")
        if (b !== bytesDone || samples.length === 0) {
            bytesDone = b
            var s = samples.concat([[now, b]]).filter(function (x) { return now - x[0] <= 8000 })
            samples = s
            speed = s.length > 1 && s[s.length - 1][0] > s[0][0] ? (s[s.length - 1][1] - s[0][1]) * 1000 / (s[s.length - 1][0] - s[0][0]) : 0
        }
    }
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
        // The slideshow loads when Calamares starts; the clock starts when the install page is shown.
        if (!started || !presentation.activatedInCalamares) { started = now; phaseStarted = now }
        elapsed = Math.floor((now - started) / 1000)
        phaseElapsed = Math.floor((now - phaseStarted) / 1000)
        encrypted = readEncrypted()
        readProgress(now)
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
                    text: presentation.copying ? qsTr("Keep the computer plugged in. You can't go back from here.")
                        : presentation.phaseElapsed > 60 ? qsTr("Applying your choices. This step is taking longer than usual; it is still working.")
                        : qsTr("Applying your choices.")
                    color: "#8FA3C8"; font.family: "IBM Plex Sans"; font.pixelSize: 15
                }
            }

            // 6 · Copy files (design board S6a): the progress card, three stat tiles and the job log. Every number is
            // real (see the properties above); a value Calamares cannot give shows "—".
            Rectangle {
                visible: presentation.copying
                Layout.fillWidth: true
                implicitHeight: copyCol.implicitHeight + 48
                radius: 16; color: "#990E2048"; border.width: 1; border.color: "#247FB2FF"
                ColumnLayout {
                    id: copyCol
                    anchors.fill: parent; anchors.margins: 24
                    spacing: 14
                    RowLayout {
                        Layout.fillWidth: true
                        Text { Layout.fillWidth: true; text: presentation.preparing ? qsTr("Preparing the disk") : qsTr("Unpacking system image"); color: "#E8EEFA"; font.family: "IBM Plex Sans"; font.pixelSize: 15; font.weight: Font.Medium }
                        Text { text: Math.round(presentation.shownPercent) + "%"; color: "#FFFFFF"; font.family: "IBM Plex Mono"; font.pixelSize: 30; font.weight: Font.Medium }
                    }
                    // The bar: a gradient fill eased toward the real progress, with the board's shimmer sweeping across it
                    // (ws-shimmer: a 40% highlight from -100% to 250% of its own width, 1.8 s ease-in-out, infinite).
                    Rectangle {
                        id: track
                        Layout.fillWidth: true; height: 10; radius: 5; color: "#1F7FB2FF"
                        Rectangle {   // glow (box-shadow 0 0 16px rgba(24,212,240,0.5))
                            x: -4; y: -4; width: fill.width + 8; height: fill.height + 8; radius: 9
                            color: "#2618D4F0"; visible: fill.width > 0
                        }
                        Rectangle {
                            id: fill
                            height: parent.height; radius: 5; clip: true
                            width: Math.max(presentation.shownFraction > 0 ? height : 0, track.width * presentation.shownFraction)
                            Behavior on width { NumberAnimation { duration: 600; easing.type: Easing.OutCubic } }
                            gradient: Gradient { orientation: Gradient.Horizontal; GradientStop { position: 0; color: "#1F6BFF" } GradientStop { position: 1; color: "#18D4F0" } }
                            Rectangle {
                                id: shine
                                width: fill.width * 0.4; height: parent.height
                                gradient: Gradient { orientation: Gradient.Horizontal; GradientStop { position: 0; color: "#00FFFFFF" } GradientStop { position: 0.5; color: "#59FFFFFF" } GradientStop { position: 1; color: "#00FFFFFF" } }
                                NumberAnimation on x {
                                    from: -shine.width; to: shine.width * 2.5; duration: 1800; easing.type: Easing.InOutQuad
                                    loops: Animation.Infinite; running: presentation.copying && fill.width > 0
                                }
                            }
                        }
                    }
                    RowLayout {
                        Layout.fillWidth: true
                        Text {
                            Layout.fillWidth: true; color: "#8FA3C8"; font.family: "IBM Plex Mono"; font.pixelSize: 12
                            text: presentation.bytesDone <= 0 ? "—"
                                : presentation.gb(presentation.shownBytes) + (presentation.bytesTotal > 0 ? qsTr(" of %1").arg(presentation.gb(presentation.bytesTotal)) : "")
                                  + (presentation.speed > 0 ? " · " + presentation.rate(presentation.speed) : "")
                        }
                        Text { text: presentation.timeLeft(); color: "#8FA3C8"; font.family: "IBM Plex Mono"; font.pixelSize: 12 }
                    }
                }
            }
            GridLayout {
                visible: presentation.copying
                Layout.fillWidth: true
                columns: 3; columnSpacing: 12
                Repeater {
                    model: [
                        [qsTr("Files copied"), presentation.filesTotal > 0 ? Math.round(presentation.shownFiles).toLocaleString(Qt.locale("en_US"), "f", 0) : "—"],
                        [qsTr("Packages"), presentation.packagesTotal > 0 ? qsTr("%1 / %2").arg(Math.round(presentation.shownPackages)).arg(presentation.packagesTotal.toLocaleString(Qt.locale("en_US"), "f", 0))
                            : presentation.imagePackages > 0 ? presentation.imagePackages.toLocaleString(Qt.locale("en_US"), "f", 0) : "—"],
                        [qsTr("Elapsed"), presentation.mmss(presentation.elapsed)]
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
            // "Show details": the job status lines Calamares reported, newest last; opens with a smooth height change.
            Rectangle {
                id: details
                visible: presentation.copying
                property bool open: false
                Layout.fillWidth: true
                implicitHeight: 44 + (open ? Math.min(logText.implicitHeight, 120) + 14 : 0)
                Behavior on implicitHeight { NumberAnimation { duration: 220; easing.type: Easing.OutCubic } }
                radius: 12; color: "#80040A1A"; border.width: 1; border.color: "#1F7FB2FF"; clip: true
                MouseArea {
                    width: parent.width; height: 44; cursorShape: Qt.PointingHandCursor
                    onClicked: details.open = !details.open
                    Row {
                        x: 16; anchors.verticalCenter: parent.verticalCenter; spacing: 8
                        Text { text: "▶"; color: "#C9D6EE"; font.pixelSize: 9; anchors.verticalCenter: parent.verticalCenter
                               rotation: details.open ? 90 : 0; Behavior on rotation { NumberAnimation { duration: 220 } } }
                        Text { text: details.open ? qsTr("Hide details") : qsTr("Show details"); color: "#C9D6EE"; font.family: "IBM Plex Sans"; font.pixelSize: 13 }
                    }
                }
                Text {
                    id: logText
                    x: 16; y: 44; width: parent.width - 32
                    opacity: details.open ? 1 : 0; Behavior on opacity { NumberAnimation { duration: 220 } }
                    text: presentation.log.slice(-6).join("\n")
                    color: "#8FA3C8"; font.family: "IBM Plex Mono"; font.pixelSize: 12; wrapMode: Text.WrapAnywhere
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
                                            RotationAnimation on rotation { from: 0; to: 360; duration: 1000; loops: Animation.Infinite; running: active } } }
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

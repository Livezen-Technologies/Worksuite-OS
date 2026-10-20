/* WorkSuite OS installer steps (SRS §9.4):
 *  mode "erase":    shows the target disk's model and size and keeps Install disabled until the disk name is typed
 *                   exactly (WSOS-INS-003). Operating systems already on the disk (Windows, Linux, macOS: dual-boot
 *                   machines) are listed by name and need a second, explicit acknowledgement. The disk is read with
 *                   lsblk in the background, behind a "Reading the disk" indicator, so the page never blocks.
 *  mode "recovery": shows the LUKS2 recovery key created by the worksuiterecovery job once, and keeps Next disabled
 *                   until the user confirms they saved it (WSOS-INS-004). Skipped for unencrypted installs.
 *  mode "enroll":   optional, after the account page (WSOS-INS-006): an enrollment code and server, or the admin
 *                   console's enrollment link pasted or read from its QR code with the camera (zbarcam). Valid input
 *                   is written to a 0600 root file (EnrollLink.h) for the worksuiteenroll job; never logged.
 *                   "Skip for now" (or Continue with both fields empty) clears the fields, writes no token and moves
 *                   on; the sidebar shows the sub-step as skipped.
 *  mode "terms":    the last page before Install: the WorkSuite OS terms (branding/worksuite/terms/LICENSE-<lang>.txt)
 *                   in a scrolling panel and an acceptance box that gates Install. The accepted version and time go to
 *                   global storage ("worksuiteTerms"); the worksuiteterms job records them on the target.
 *                   `accepted: true` in the instance config pre-accepts (unattended / OEM images).
 */
#pragma once

#include "DllMacro.h"
#include "utils/PluginFactory.h"
#include "viewpages/ViewStep.h"

#include <QString>

class QCheckBox;
class QFrame;
class QGridLayout;
class QVBoxLayout;
class QLabel;
class QLineEdit;
class QWidget;

class PLUGINDLLEXPORT WorksuiteConfirmViewStep : public Calamares::ViewStep
{
    Q_OBJECT

public:
    explicit WorksuiteConfirmViewStep( QObject* parent = nullptr );
    ~WorksuiteConfirmViewStep() override;

    QString prettyName() const override;
    QWidget* widget() override;
    bool isNextEnabled() const override;
    bool isBackEnabled() const override;
    bool isAtBeginning() const override;
    bool isAtEnd() const override;
    Calamares::JobList jobs() const override;
    void onActivate() override;
    void onLeave() override;
    void setConfigurationMap( const QVariantMap& configurationMap ) override;

    /// Disk node ("sda", "nvme0n1") named in planned job descriptions; empty if none or ambiguous.
    static QString diskFromDescriptions( const QStringList& descriptions );
    /// Exact match after trimming; "/dev/" prefix allowed.
    static bool confirmationMatches( const QString& typed, const QString& disk );
    /// The branding stylesheet's rules for dialogs (QDialog, QMessageBox), plus its QPushButton rules scoped to QDialog.
    static QString dialogStyleSheet( const QString& sheet );
    /// MODEL and SIZE from `lsblk -dnPo MODEL,SIZE` output (KEY="value" pairs); either may be empty.
    static void parseLsblk( const QString& out, QString& model, QString& size );
    /// The operating system a partition belongs to, from lsblk's FSTYPE, LABEL and PARTLABEL: "Windows", "macOS",
    /// "Linux", or empty for partitions that hold no system of their own (EFI, swap, unformatted).
    static QString systemOf( const QString& fstype, const QString& label, const QString& partlabel );
    /// Existing systems on a disk from `lsblk -nPo NAME,TYPE,FSTYPE,LABEL,PARTLABEL,SIZE` output: one line per
    /// partition with a system, "Windows · sda3 · 200G (ntfs)".
    static QStringList existingSystems( const QString& lsblkOut );
    /// What still keeps Install disabled on the erase page, empty when nothing does.
    static QString eraseBlocker( const QString& typed, const QString& disk, bool reading, bool hasSystems, bool acknowledged );
    /// Disk card header: "Model · Size (node)", or "node · Size" when the model is empty.
    static QString diskTitle( const QString& disk, const QString& model, const QString& size );
    /// Tag kind for one planned partition job: "FORMAT", "DELETE", "CREATE", "OTHER" (neutral) or empty (hidden:
    /// housekeeping such as clearing mounts).
    static QString opKind( const QString& description );
    /// True when a planned job sets up encryption (LUKS).
    static bool encryptedFromDescriptions( const QStringList& descriptions );
    /// The terms file for a language: <dir>/LICENSE-<lang>.txt ("si_LK" → si), else LICENSE-en.txt; empty if none.
    static QString termsFile( const QString& dir, const QString& lang );
    /// The "Version: …" line of a terms text; "unversioned" when it has none.
    static QString termsVersion( const QString& text );

    /// Enroll page: "Skip for now" — clears both fields, removes any pending token and goes to the next step.
    void skipEnrollment();
    /// Terms page: the acceptance box (tests; the page's checkbox does the same).
    void setTermsAccepted( bool on );

private:
    void refresh();
    void readDisk();
    void diskRead( const QString& lsblkOut );

    void scanQr();
    void enrollChanged();
    void recordEnrollSkipped( bool skipped );
    void termsChanged();

    enum class Mode { Erase, Recovery, Enroll, Terms };
    Mode m_mode = Mode::Erase;
    QWidget* m_widget = nullptr;
    QLabel* m_eyebrow = nullptr;
    QLabel* m_title = nullptr;
    QLabel* m_details = nullptr;
    QLabel* m_diskName = nullptr;   // erase: disk card header
    QLabel* m_diskNode = nullptr;
    QVBoxLayout* m_ops = nullptr;   // erase: the planned partition changes
    QLabel* m_inputLabel = nullptr;
    QLabel* m_busy = nullptr;       // erase: "Reading the disk…" while lsblk runs
    QFrame* m_systemsBox = nullptr; // erase: the operating systems found on the disk
    QLabel* m_systems = nullptr;
    QCheckBox* m_systemsAck = nullptr;
    QLabel* m_validation = nullptr; // erase: what still keeps Install disabled
    class QProcess* m_lsblk = nullptr;
    bool m_reading = false;
    QFrame* m_keyBox = nullptr;     // recovery: the key in groups
    QGridLayout* m_keyGrid = nullptr;
    QLineEdit* m_input = nullptr;
    QLabel* m_key = nullptr;
    QCheckBox* m_saved = nullptr;
    QLineEdit* m_server = nullptr;  // enroll
    QLabel* m_status = nullptr;     // enroll: what the input means, or why it is not usable
    class QPushButton* m_scan = nullptr;
    class QPushButton* m_skip = nullptr;   // enroll: "Skip for now"
    class QTextBrowser* m_terms = nullptr; // terms: the text
    QCheckBox* m_accept = nullptr;         // terms: "I have read and accept…"
    QString m_termsVersion;
    bool m_preaccepted = false;            // terms: `accepted: true` in the config (unattended)
    QString m_disk;
    bool m_ok = false;
};

CALAMARES_PLUGIN_FACTORY_DECLARATION( WorksuiteConfirmViewStepFactory )

/* WorkSuite OS installer steps (SRS §9.4):
 *  mode "erase":    shows the target disk's model and size and keeps Install disabled until the disk name is typed
 *                   exactly (WSOS-INS-003).
 *  mode "recovery": shows the LUKS2 recovery key created by the worksuiterecovery job once, and keeps Next disabled
 *                   until the user confirms they saved it (WSOS-INS-004). Skipped for unencrypted installs.
 */
#pragma once

#include "DllMacro.h"
#include "utils/PluginFactory.h"
#include "viewpages/ViewStep.h"

#include <QString>

class QCheckBox;
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

private:
    void refresh();

    enum class Mode { Erase, Recovery };
    Mode m_mode = Mode::Erase;
    QWidget* m_widget = nullptr;
    QLabel* m_title = nullptr;
    QLabel* m_details = nullptr;
    QLineEdit* m_input = nullptr;
    QLabel* m_key = nullptr;
    QCheckBox* m_saved = nullptr;
    QString m_disk;
    bool m_ok = false;
};

CALAMARES_PLUGIN_FACTORY_DECLARATION( WorksuiteConfirmViewStepFactory )

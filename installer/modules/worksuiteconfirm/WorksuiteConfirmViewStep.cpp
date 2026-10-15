#include "WorksuiteConfirmViewStep.h"

#include "GlobalStorage.h"
#include "JobQueue.h"
#include "ViewManager.h"
#include "utils/Logger.h"

#include <QCheckBox>
#include <QFont>
#include <QLabel>
#include <QLineEdit>
#include <QProcess>
#include <QRegularExpression>
#include <QSet>
#include <QVBoxLayout>

CALAMARES_PLUGIN_FACTORY_DEFINITION( WorksuiteConfirmViewStepFactory, registerPlugin< WorksuiteConfirmViewStep >(); )

static const char RECOVERY_KEY[] = "worksuiteRecoveryKey";

WorksuiteConfirmViewStep::WorksuiteConfirmViewStep( QObject* parent )
    : Calamares::ViewStep( parent )
{
}

WorksuiteConfirmViewStep::~WorksuiteConfirmViewStep()
{
    if ( m_widget && !m_widget->parent() )
    {
        delete m_widget;
    }
}

QString
WorksuiteConfirmViewStep::prettyName() const
{
    return m_mode == Mode::Erase ? tr( "Confirm erase" ) : tr( "Recovery key" );
}

void
WorksuiteConfirmViewStep::setConfigurationMap( const QVariantMap& map )
{
    m_mode = map.value( QStringLiteral( "mode" ) ).toString() == QStringLiteral( "recovery" ) ? Mode::Recovery : Mode::Erase;
}

QString
WorksuiteConfirmViewStep::diskFromDescriptions( const QStringList& descriptions )
{
    static const QRegularExpression node( QStringLiteral( "/dev/(nvme\\d+n\\d+|mmcblk\\d+|sd[a-z]+|vd[a-z]+|xvd[a-z]+)(?![a-z0-9])" ) );
    QSet< QString > disks;
    for ( const QString& d : descriptions )
    {
        auto it = node.globalMatch( d );
        while ( it.hasNext() )
        {
            disks.insert( it.next().captured( 1 ) );
        }
    }
    // A single target disk only: anything else is not a whole-disk install this step can confirm.
    return disks.size() == 1 ? *disks.begin() : QString();
}

bool
WorksuiteConfirmViewStep::confirmationMatches( const QString& typed, const QString& disk )
{
    QString t = typed.trimmed();
    if ( t.startsWith( QStringLiteral( "/dev/" ) ) )
    {
        t = t.mid( 5 );
    }
    return !disk.isEmpty() && t == disk;
}

QWidget*
WorksuiteConfirmViewStep::widget()
{
    if ( m_widget )
    {
        return m_widget;
    }
    m_widget = new QWidget;
    auto* layout = new QVBoxLayout( m_widget );
    m_title = new QLabel;
    QFont big = m_title->font();
    big.setPointSizeF( big.pointSizeF() * 1.4 );
    big.setBold( true );
    m_title->setFont( big );
    m_title->setWordWrap( true );
    m_details = new QLabel;
    m_details->setWordWrap( true );
    m_details->setTextFormat( Qt::PlainText );
    layout->addWidget( m_title );
    layout->addWidget( m_details );

    if ( m_mode == Mode::Erase )
    {
        m_input = new QLineEdit;
        m_input->setAccessibleName( tr( "Type the disk name to confirm" ) );
        layout->addWidget( m_input );
        connect( m_input, &QLineEdit::textChanged, this, [ this ] { refresh(); } );
    }
    else
    {
        m_key = new QLabel;
        QFont mono( QStringLiteral( "monospace" ) );
        mono.setPointSizeF( big.pointSizeF() );
        m_key->setFont( mono );
        m_key->setTextInteractionFlags( Qt::TextSelectableByMouse );
        m_saved = new QCheckBox( tr( "I have written down or stored this recovery key somewhere safe" ) );
        layout->addWidget( m_key );
        layout->addWidget( m_saved );
        connect( m_saved, &QCheckBox::toggled, this, [ this ] { refresh(); } );
    }
    layout->addStretch();
    return m_widget;
}

void
WorksuiteConfirmViewStep::onActivate()
{
    widget();
    if ( m_mode == Mode::Erase )
    {
        // The partition step's planned jobs are what the summary page lists; take the target disk from them.
        QStringList descriptions;
        for ( auto* step : Calamares::ViewManager::instance()->viewSteps() )
        {
            if ( step == this )
            {
                break;
            }
            for ( const auto& job : step->jobs() )
            {
                descriptions << job->prettyName() << job->prettyDescription();
            }
        }
        m_disk = diskFromDescriptions( descriptions );
        QString model, size;
        if ( !m_disk.isEmpty() )
        {
            QProcess p;
            p.start( QStringLiteral( "lsblk" ), { QStringLiteral( "-dno" ), QStringLiteral( "MODEL,SIZE" ), QStringLiteral( "/dev/" ) + m_disk } );
            p.waitForFinished( 5000 );
            const QString out = QString::fromUtf8( p.readAllStandardOutput() ).simplified();
            const int cut = out.lastIndexOf( QLatin1Char( ' ' ) );
            model = cut > 0 ? out.left( cut ) : out;
            size = cut > 0 ? out.mid( cut + 1 ) : QString();
        }
        m_title->setText( tr( "Everything on this disk will be erased" ) );
        m_details->setText( m_disk.isEmpty()
                                ? tr( "The target disk could not be identified. Go back and choose the disk again." )
                                : tr( "Disk: %1 (%2, %3)\nAll files and operating systems on it will be deleted. "
                                      "Type %1 below to confirm." ).arg( m_disk, model.isEmpty() ? tr( "unknown model" ) : model, size ) );
        m_input->clear();
        m_input->setEnabled( !m_disk.isEmpty() );
        m_input->setFocus();
    }
    else
    {
        const QString key = Calamares::JobQueue::instance()->globalStorage()->value( QString::fromLatin1( RECOVERY_KEY ) ).toString();
        m_title->setText( tr( "Save your recovery key" ) );
        m_details->setText( tr( "If you forget your disk password, this key is the only way to unlock this computer. "
                                "It is shown once and is not stored on this computer." ) );
        m_key->setText( key );
        m_saved->setChecked( false );
        if ( key.isEmpty() )
        {
            // Unencrypted install: nothing to show.
            m_ok = true;
            emit nextStatusChanged( true );
            Calamares::ViewManager::instance()->next();
            return;
        }
    }
    refresh();
}

void
WorksuiteConfirmViewStep::onLeave()
{
    if ( m_mode == Mode::Recovery && m_ok )
    {
        // Shown once: drop it from memory as soon as the user moves on.
        Calamares::JobQueue::instance()->globalStorage()->remove( QString::fromLatin1( RECOVERY_KEY ) );
        if ( m_key )
        {
            m_key->clear();
        }
    }
}

void
WorksuiteConfirmViewStep::refresh()
{
    const bool ok = m_mode == Mode::Erase ? confirmationMatches( m_input->text(), m_disk ) : m_saved->isChecked();
    if ( ok != m_ok )
    {
        m_ok = ok;
        emit nextStatusChanged( ok );
    }
}

bool
WorksuiteConfirmViewStep::isNextEnabled() const
{
    return m_ok;
}

bool
WorksuiteConfirmViewStep::isBackEnabled() const
{
    // The recovery step comes after installation: there is nothing to go back to.
    return m_mode == Mode::Erase;
}

bool
WorksuiteConfirmViewStep::isAtBeginning() const
{
    return true;
}

bool
WorksuiteConfirmViewStep::isAtEnd() const
{
    return true;
}

Calamares::JobList
WorksuiteConfirmViewStep::jobs() const
{
    return {};
}

#include "WorksuiteConfirmViewStep.h"

#include "GlobalStorage.h"
#include "JobQueue.h"
#include "ViewManager.h"
#include "utils/Logger.h"

#include <QCheckBox>
#include <QFrame>
#include <QGridLayout>
#include <QHBoxLayout>
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

// Layout of the design's "5 · Confirm disk" and "6 · Recovery key" screens; branding/worksuite/stylesheet.qss
// styles the parts by object name (#wsConfirm …).
static QLabel*
label( const QString& name, QWidget* parent = nullptr )
{
    auto* l = new QLabel( parent );
    l->setObjectName( name );
    l->setWordWrap( true );
    return l;
}

QWidget*
WorksuiteConfirmViewStep::widget()
{
    if ( m_widget )
    {
        return m_widget;
    }
    m_widget = new QWidget;
    m_widget->setObjectName( m_mode == Mode::Erase ? QStringLiteral( "wsConfirm" ) : QStringLiteral( "wsRecovery" ) );
    m_widget->setAttribute( Qt::WA_StyledBackground );
    auto* layout = new QVBoxLayout( m_widget );
    layout->setContentsMargins( 56, 40, 56, 24 );
    layout->setSpacing( 22 );

    auto* head = new QVBoxLayout;
    head->setSpacing( 6 );
    m_eyebrow = label( QStringLiteral( "wsEyebrow" ) );
    m_title = label( QStringLiteral( "wsTitle" ) );
    m_details = label( QStringLiteral( "wsSubtitle" ) );
    m_details->setTextFormat( Qt::PlainText );
    head->addWidget( m_eyebrow );
    head->addWidget( m_title );
    head->addWidget( m_details );
    layout->addLayout( head );

    if ( m_mode == Mode::Erase )
    {
        // Disk card: name and node, then one row per planned change.
        auto* card = new QFrame;
        card->setObjectName( QStringLiteral( "wsDiskCard" ) );
        auto* cardLayout = new QVBoxLayout( card );
        cardLayout->setContentsMargins( 0, 0, 0, 8 );
        cardLayout->setSpacing( 0 );
        auto* header = new QFrame;
        header->setObjectName( QStringLiteral( "wsDiskHeader" ) );
        auto* headerLayout = new QHBoxLayout( header );
        headerLayout->setContentsMargins( 20, 16, 20, 16 );
        m_diskName = label( QStringLiteral( "wsDiskName" ) );
        m_diskNode = label( QStringLiteral( "wsDiskNode" ) );
        m_diskNode->setWordWrap( false );
        headerLayout->addWidget( m_diskName, 1 );
        headerLayout->addWidget( m_diskNode );
        cardLayout->addWidget( header );
        m_ops = new QVBoxLayout;
        m_ops->setContentsMargins( 20, 8, 20, 0 );
        m_ops->setSpacing( 4 );
        cardLayout->addLayout( m_ops );
        layout->addWidget( card );

        m_inputLabel = label( QStringLiteral( "wsFieldLabel" ) );
        m_input = new QLineEdit;
        m_input->setObjectName( QStringLiteral( "wsConfirmInput" ) );
        m_input->setAccessibleName( tr( "Type the disk name to confirm" ) );
        layout->addWidget( m_inputLabel );
        layout->addWidget( m_input );
        connect( m_input, &QLineEdit::textChanged, this, [ this ] { refresh(); } );
    }
    else
    {
        m_keyBox = new QFrame;
        m_keyBox->setObjectName( QStringLiteral( "wsKeyBox" ) );
        m_keyGrid = new QGridLayout( m_keyBox );
        m_keyGrid->setContentsMargins( 24, 24, 24, 24 );
        m_keyGrid->setSpacing( 12 );
        layout->addWidget( m_keyBox );
        m_key = label( QStringLiteral( "wsKeyPlain" ) );   // the whole key, selectable, for screen readers and copying
        m_key->setTextInteractionFlags( Qt::TextSelectableByMouse );
        layout->addWidget( m_key );
        m_saved = new QCheckBox( tr( "I've saved my recovery key somewhere safe" ) );
        m_saved->setObjectName( QStringLiteral( "wsAck" ) );
        layout->addWidget( m_saved );
        connect( m_saved, &QCheckBox::toggled, this, [ this ] { refresh(); } );
    }
    layout->addStretch();
    return m_widget;
}

// One row of the disk card: a tag (DELETE / CREATE / FORMAT) and what the partition step will do.
static QWidget*
opRow( const QString& tag, const QString& text )
{
    auto* row = new QWidget;
    auto* l = new QHBoxLayout( row );
    l->setContentsMargins( 0, 6, 0, 6 );
    l->setSpacing( 14 );
    auto* t = label( QStringLiteral( "wsTag" ) );
    t->setProperty( "kind", tag );
    t->setText( tag );
    t->setAlignment( Qt::AlignCenter );
    t->setFixedWidth( 64 );
    t->setWordWrap( false );
    auto* d = label( QStringLiteral( "wsOp" ) );
    d->setTextFormat( Qt::PlainText );
    d->setText( text );
    l->addWidget( t, 0, Qt::AlignTop );
    l->addWidget( d, 1 );
    return row;
}

void
WorksuiteConfirmViewStep::onActivate()
{
    widget();
    if ( m_mode == Mode::Erase )
    {
        // The partition step's planned jobs are what the summary page lists; take the target disk from them.
        QStringList descriptions, changes;
        for ( auto* step : Calamares::ViewManager::instance()->viewSteps() )
        {
            if ( step == this )
            {
                break;
            }
            for ( const auto& job : step->jobs() )
            {
                descriptions << job->prettyName() << job->prettyDescription();
                if ( job->prettyName().contains( QStringLiteral( "/dev/" ) ) )
                {
                    changes << job->prettyName();   // the partition step's changes, not users, locale, …
                }
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
        m_eyebrow->setText( tr( "STEP 5 · CONFIRM DISK" ) );
        m_title->setText( tr( "This will erase your disk" ) );
        m_details->setText( m_disk.isEmpty()
                                ? tr( "The target disk could not be identified. Go back and choose the disk again." )
                                : tr( "After you press Install, these changes can't be undone." ) );
        m_diskName->setText( m_disk.isEmpty() ? tr( "Unknown disk" )
                                              : QStringLiteral( "%1 · %2" ).arg( model.isEmpty() ? m_disk : model, size ) );
        m_diskNode->setText( m_disk.isEmpty() ? QString() : QStringLiteral( "/dev/" ) + m_disk );
        while ( auto* item = m_ops->takeAt( 0 ) )
        {
            delete item->widget();
            delete item;
        }
        m_ops->addWidget( opRow( tr( "DELETE" ), tr( "Existing partition table and all data" ) ) );
        for ( const QString& c : changes )
        {
            const QString lower = c.toLower();
            const QString tag = lower.contains( QStringLiteral( "format" ) ) ? tr( "FORMAT" )
                : lower.contains( QStringLiteral( "delete" ) ) || lower.contains( QStringLiteral( "remove" ) ) ? tr( "DELETE" )
                                                                                                              : tr( "CREATE" );
            m_ops->addWidget( opRow( tag, QString( c ).remove( QRegularExpression( QStringLiteral( "<[^>]*>" ) ) ) ) );
        }
        m_inputLabel->setText( tr( "Type %1 to confirm that all data on it will be permanently deleted" ).arg( m_disk ) );
        m_input->clear();
        m_input->setEnabled( !m_disk.isEmpty() );
        m_input->setFocus();
    }
    else
    {
        const QString key = Calamares::JobQueue::instance()->globalStorage()->value( QString::fromLatin1( RECOVERY_KEY ) ).toString();
        m_eyebrow->setText( tr( "STEP 6 · RECOVERY KEY" ) );
        m_title->setText( tr( "Save your recovery key" ) );
        m_details->setText( tr( "If you forget your disk passphrase, this key is the only way to unlock your files. "
                                "It is shown once and is not stored on this computer." ) );
        m_key->setText( key );
        // The key's groups in a four-column grid, as in the design.
        while ( auto* item = m_keyGrid->takeAt( 0 ) )
        {
            delete item->widget();
            delete item;
        }
        const QStringList groups = key.split( QLatin1Char( '-' ), Qt::SkipEmptyParts );
        for ( int i = 0; i < groups.size(); ++i )
        {
            auto* g = label( QStringLiteral( "wsKeyGroup" ) );
            g->setWordWrap( false );
            g->setAlignment( Qt::AlignCenter );
            g->setText( groups.at( i ) );
            m_keyGrid->addWidget( g, i / 4, i % 4 );
        }
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

#include "WsStyle.h"

#include "ViewManager.h"

#include <QAbstractItemView>
#include <QApplication>
#include <QButtonGroup>
#include <QCheckBox>
#include <QComboBox>
#include <QCoreApplication>
#include <QDialog>
#include <QDialogButtonBox>
#include <QFrame>
#include <QGraphicsDropShadowEffect>
#include <QGridLayout>
#include <QHBoxLayout>
#include <QLabel>
#include <QIdentityProxyModel>
#include <QLineEdit>
#include <QMessageBox>
#include <QPainter>
#include <QPainterPath>
#include <QPointer>
#include <QPushButton>
#include <QRadioButton>
#include <QRegularExpression>
#include <QSettings>
#include <QStyle>
#include <QTextBrowser>
#include <QTimer>
#include <QVBoxLayout>

namespace
{
// extract.py collects the tr() strings of this file under the context "WsStyle".
QString
tr( const char* s )
{
    return QCoreApplication::translate( "WsStyle", s );
}

// branding/worksuite/WsState.qml: the file the QML pages (sidebar, footer) share their state through.
const char WS_STATE[] = "/run/worksuite-installer.conf";

QVariant
stateValue( const char* key, const QVariant& fallback )
{
    QSettings s( QString::fromLatin1( WS_STATE ), QSettings::IniFormat );
    return s.value( QString::fromLatin1( key ), fallback );
}

void
setState( const char* key, const QVariant& value )
{
    QSettings s( QString::fromLatin1( WS_STATE ), QSettings::IniFormat );
    s.setValue( QString::fromLatin1( key ), value );
    s.sync();
}

QLabel*
label( const QString& name, const QString& text = QString(), QWidget* parent = nullptr )
{
    auto* l = new QLabel( text, parent );
    l->setObjectName( name );
    return l;
}

void
repolish( QWidget* w )
{
    w->style()->unpolish( w );
    w->style()->polish( w );
    w->update();
}

/* The design's line icons (24-unit grid, 2-unit round strokes), drawn rather than loaded: no SVG module needed. */
QPixmap
icon( const QString& kind, const QColor& color, int size )
{
    const qreal dpr = qApp ? qApp->devicePixelRatio() : 1.0;
    QPixmap pm( QSize( size, size ) * dpr );
    pm.setDevicePixelRatio( dpr );
    pm.fill( Qt::transparent );
    QPainter p( &pm );
    p.setRenderHint( QPainter::Antialiasing );
    p.scale( size / 24.0, size / 24.0 );
    p.setPen( QPen( color, kind == QLatin1String( "check" ) || kind == QLatin1String( "cross" ) ? 2.2 : 2.0, Qt::SolidLine, Qt::RoundCap, Qt::RoundJoin ) );
    p.setBrush( Qt::NoBrush );
    QPainterPath path;
    if ( kind == QLatin1String( "lock" ) || kind == QLatin1String( "unlock" ) )
    {
        path.addRoundedRect( QRectF( 5, 11, 14, 10 ), 2, 2 );
        path.moveTo( 8, 11 );
        path.lineTo( 8, 7 );
        if ( kind == QLatin1String( "lock" ) )
        {
            path.arcTo( QRectF( 8, 3, 8, 8 ), 180, -180 );
            path.lineTo( 16, 11 );
        }
        else
        {
            path.arcTo( QRectF( 8, 3, 8, 8 ), 180, -120 );
        }
    }
    else if ( kind == QLatin1String( "disk" ) )
    {
        // <rect x="3" y="6" width="18" height="12" rx="2"/><circle cx="17" cy="12" r="1"/>
        path.addRoundedRect( QRectF( 3, 6, 18, 12 ), 2, 2 );
        path.addEllipse( QPointF( 17, 12 ), 1, 1 );
    }
    else if ( kind == QLatin1String( "warn" ) )
    {
        path.moveTo( 12, 3 );
        path.lineTo( 22, 21 );
        path.lineTo( 2, 21 );
        path.closeSubpath();
        path.moveTo( 12, 10 );
        path.lineTo( 12, 15 );
        path.moveTo( 12, 18 );
        path.lineTo( 12.01, 18 );
    }
    else if ( kind == QLatin1String( "check" ) )
    {
        path.moveTo( 5, 12.5 );
        path.lineTo( 10, 17.5 );
        path.lineTo( 19, 7 );
    }
    else if ( kind == QLatin1String( "cross" ) )
    {
        path.moveTo( 6, 6 );
        path.lineTo( 18, 18 );
        path.moveTo( 18, 6 );
        path.lineTo( 6, 18 );
    }
    else
    {
        path.addEllipse( QPointF( 12, 12 ), 9, 9 );
        if ( kind == QLatin1String( "question" ) )
        {
            path.moveTo( 9.5, 9.5 );
            path.arcTo( QRectF( 9.5, 7, 5, 5 ), 180, -235 );
            path.lineTo( 12, 13.3 );
            path.lineTo( 12, 14 );
            path.moveTo( 12, 17 );
            path.lineTo( 12.01, 17 );
        }
        else if ( kind == QLatin1String( "error" ) )
        {
            path.moveTo( 9, 9 );
            path.lineTo( 15, 15 );
            path.moveTo( 15, 9 );
            path.lineTo( 9, 15 );
        }
        else  // info
        {
            path.moveTo( 12, 11 );
            path.lineTo( 12, 17 );
            path.moveTo( 12, 7.5 );
            path.lineTo( 12.01, 7.5 );
        }
    }
    p.drawPath( path );
    return pm;
}

QLabel*
iconLabel( const QString& kind, const QColor& color, int size )
{
    auto* l = new QLabel;
    l->setPixmap( icon( kind, color, size ) );
    l->setFixedSize( size, size );
    l->setAttribute( Qt::WA_TransparentForMouseEvents );
    return l;
}

/* ------------------------------------------------------------------------------------------------------------
   Partition bars: the design's Before / After bars, drawn from the partition module's own models. */
struct Segment
{
    qint64 size = 0;
    QString kind;   // "free", "efi", "root", "other"
    QString text;   // legend
};

class Bar : public QWidget
{
public:
    explicit Bar( QWidget* parent = nullptr )
        : QWidget( parent )
    {
        setFixedHeight( 22 );
        setSizePolicy( QSizePolicy::Expanding, QSizePolicy::Fixed );
    }
    void setSegments( const QList< Segment >& s )
    {
        m_segments = s;
        update();
    }

protected:
    void paintEvent( QPaintEvent* ) override
    {
        QPainter p( this );
        p.setRenderHint( QPainter::Antialiasing );
        QPainterPath clip;
        clip.addRoundedRect( QRectF( rect() ), 6, 6 );
        p.setClipPath( clip );
        qint64 total = 0;
        for ( const auto& s : m_segments )
        {
            total += s.size;
        }
        if ( total <= 0 )
        {
            paintFree( p, rect() );
            return;
        }
        const int gaps = 2 * ( m_segments.count() - 1 );
        const int avail = width() - gaps;
        // Small partitions keep at least 8 px (the design's EFI sliver); the rest share what is left.
        QList< int > widths;
        int fixed = 0;
        qint64 flexTotal = 0;
        for ( const auto& s : m_segments )
        {
            const int w = int( avail * double( s.size ) / double( total ) );
            if ( w < 8 )
            {
                widths << 8;
                fixed += 8;
            }
            else
            {
                widths << -1;
                flexTotal += s.size;
            }
        }
        int x = 0;
        for ( int i = 0; i < m_segments.count(); ++i )
        {
            int w = widths[ i ] > 0 ? widths[ i ] : int( ( avail - fixed ) * double( m_segments[ i ].size ) / double( qMax< qint64 >( 1, flexTotal ) ) );
            if ( i == m_segments.count() - 1 )
            {
                w = width() - x;
            }
            const QRect r( x, 0, w, height() );
            const QString& k = m_segments[ i ].kind;
            if ( k == QLatin1String( "free" ) )
            {
                paintFree( p, r );
            }
            else if ( k == QLatin1String( "root" ) )
            {
                QLinearGradient g( r.topLeft(), r.topRight() );
                g.setColorAt( 0, QColor( "#1F6BFF" ) );
                g.setColorAt( 1, QColor( "#18D4F0" ) );
                p.fillRect( r, g );
            }
            else
            {
                p.fillRect( r, k == QLatin1String( "efi" ) ? QColor( "#FF9F5A" ) : QColor( "#7FB2FF" ) );
            }
            x += w + 2;
        }
    }

private:
    // repeating-linear-gradient(45deg, rgba(127,178,255,0.14) 0 8px, rgba(127,178,255,0.06) 8px 16px)
    static void paintFree( QPainter& p, const QRect& r )
    {
        p.save();
        p.setClipRect( r, Qt::IntersectClip );
        p.fillRect( r, QColor( 127, 178, 255, 15 ) );
        p.setPen( QPen( QColor( 127, 178, 255, 36 ), 8 / 1.0, Qt::SolidLine, Qt::FlatCap ) );
        const qreal step = 16 * 1.41421;
        for ( qreal x = r.left() - r.height() - step; x < r.right() + step; x += step )
        {
            p.drawLine( QPointF( x, r.bottom() + 4 ), QPointF( x + r.height() + 8, r.top() - 4 ) );
        }
        p.restore();
    }
    QList< Segment > m_segments;
};

// PartitionModel (partition/core/PartitionModel.h): columns and roles.
enum
{
    NameColumn = 0,
    FileSystemColumn = 1,
    MountPointColumn = 3,
    SizeRole = Qt::UserRole + 1,
    IsFreeSpaceRole,
    IsPartitionNewRole,
    FileSystemLabelRole,
    FileSystemTypeRole
};

QList< Segment >
segmentsOf( QAbstractItemModel* model, bool after )
{
    QList< Segment > out;
    if ( !model )
    {
        return out;
    }
    for ( int row = 0; row < model->rowCount(); ++row )
    {
        const QModelIndex i = model->index( row, NameColumn );
        Segment s;
        s.size = i.data( SizeRole ).toLongLong();
        const QString fs = model->index( row, FileSystemColumn ).data().toString();
        const QString mount = model->index( row, MountPointColumn ).data().toString();
        if ( i.data( IsFreeSpaceRole ).toBool() )
        {
            s.kind = QStringLiteral( "free" );
            s.text = tr( "Unpartitioned space" ) + QStringLiteral( " · " ) + WsStyle::sizeText( s.size );
        }
        else if ( after && mount == QLatin1String( "/boot/efi" ) )
        {
            s.kind = QStringLiteral( "efi" );
            s.text = tr( "EFI system" ) + QStringLiteral( " · " ) + WsStyle::sizeText( s.size ) + QStringLiteral( " · FAT32" );
        }
        else if ( after && mount == QLatin1String( "/" ) )
        {
            s.kind = QStringLiteral( "root" );
            QString fsText = fs.contains( QLatin1String( "luks" ), Qt::CaseInsensitive ) ? QStringLiteral( "ext4 · LUKS2" ) : fs;
            s.text = QStringLiteral( "WorkSuite · " ) + WsStyle::sizeText( s.size ) + QStringLiteral( " · " ) + fsText;
        }
        else
        {
            s.kind = QStringLiteral( "other" );
            s.text = i.data().toString() + QStringLiteral( " · " ) + WsStyle::sizeText( s.size )
                + ( fs.isEmpty() ? QString() : QStringLiteral( " · " ) + fs );
        }
        out << s;
    }
    return out;
}

QAbstractItemModel*
barsModel( QWidget* frame )
{
    if ( !frame )
    {
        return nullptr;
    }
    for ( auto* v : frame->findChildren< QAbstractItemView* >() )
    {
        if ( v->inherits( "PartitionBarsView" ) )
        {
            return v->model();
        }
    }
    return nullptr;
}

/* ------------------------------------------------------------------------------------------------------------
   The ChoicePage restyle. */
class DeviceNames : public QIdentityProxyModel
{
public:
    using QIdentityProxyModel::QIdentityProxyModel;
    QVariant data( const QModelIndex& index, int role ) const override
    {
        if ( role == Qt::DecorationRole )
        {
            return QVariant();
        }
        QVariant v = QIdentityProxyModel::data( index, role );
        if ( role == Qt::DisplayRole )
        {
            QString t = v.toString().replace( QStringLiteral( " - " ), QStringLiteral( " · " ) );
            const int paren = t.lastIndexOf( QStringLiteral( " (/dev/" ) );
            return paren > 0 ? t.left( paren ) : t;
        }
        return v;
    }
};

class DiskPage : public QWidget
{
public:
    DiskPage( QWidget* page )
        : QWidget( page )
        , m_page( page )
    {
        setObjectName( QStringLiteral( "wsDiskPage" ) );
        setAttribute( Qt::WA_StyledBackground );
        page->installEventFilter( this );

        // The stock widgets that carry behaviour.
        for ( auto* c : page->findChildren< QComboBox* >( QString(), Qt::FindDirectChildrenOnly ) )
        {
            m_drives = c;
        }
        m_encrypt = page->findChild< QCheckBox* >( QStringLiteral( "m_encryptCheckBox" ) );
        m_pass = page->findChild< QLineEdit* >( QStringLiteral( "m_passphraseLineEdit" ) );
        m_confirm = page->findChild< QLineEdit* >( QStringLiteral( "m_confirmLineEdit" ) );
        m_beforeFrame = page->findChild< QWidget* >( QStringLiteral( "m_previewBeforeFrame" ) );
        m_afterFrame = page->findChild< QWidget* >( QStringLiteral( "m_previewAfterFrame" ) );

        // Everything stock goes into a hidden holder; what the design shows is taken back out below.
        auto* holder = new QWidget( page );
        holder->setObjectName( QStringLiteral( "wsStockHolder" ) );
        holder->hide();
        for ( auto* c : page->findChildren< QWidget* >( QString(), Qt::FindDirectChildrenOnly ) )
        {
            if ( c != this && c != holder )
            {
                c->setParent( holder );
            }
        }
        if ( auto* l = page->layout() )
        {
            l->setContentsMargins( 0, 0, 0, 0 );
        }

        auto* outer = new QVBoxLayout( this );
        outer->setContentsMargins( 56, 40, 56, 24 );
        outer->setSpacing( 0 );
        m_disk = buildDisk();
        m_enc = buildEncryption();
        // Each sub-step takes the whole height and packs its content at the top: sized from height-for-width alone
        // (the wrapped texts), the stock fields' fixed heights were under-counted and the cards overlapped.
        outer->addWidget( m_disk, 1 );
        outer->addWidget( m_enc, 1 );
        if ( m_encrypt )
        {
            // Stays shown (at no size): the encryption widget reads an invisible box as "encrypt".
            m_encrypt->setParent( this );
            m_encrypt->setFixedSize( 0, 0 );
            m_encrypt->setFocusPolicy( Qt::NoFocus );
            outer->addWidget( m_encrypt );
            m_encrypt->show();
            QObject::connect( m_encrypt, &QCheckBox::toggled, this, [ this ] { refreshEncryption(); } );
        }
        for ( QLineEdit* e : { m_pass.data(), m_confirm.data() } )
        {
            if ( e )
            {
                e->setPlaceholderText( QString() );
                QObject::connect( e, &QLineEdit::textChanged, this, [ this ] { refreshEncryption(); } );
            }
        }

        adoptStock();
        m_timer.setInterval( 250 );
        QObject::connect( &m_timer, &QTimer::timeout, this, [ this ] { poll(); } );
        setGeometry( page->rect() );
        show();
        raise();
        setSub( 0 );
        refreshEncryption();
        refreshBars();
        if ( page->isVisible() )
        {
            arrive();
        }
    }

protected:
    bool eventFilter( QObject* o, QEvent* e ) override
    {
        if ( o == m_page )
        {
            if ( e->type() == QEvent::Resize )
            {
                setGeometry( m_page->rect() );
            }
            else if ( e->type() == QEvent::Show )
            {
                arrive();
            }
            else if ( e->type() == QEvent::Hide )
            {
                leave();
            }
        }
        return false;
    }

private:
    QWidget* buildDisk()
    {
        auto* w = new QWidget;
        auto* l = new QVBoxLayout( w );
        l->setContentsMargins( 0, 0, 0, 0 );
        l->setSpacing( 22 );

        auto* titles = new QVBoxLayout;
        titles->setSpacing( 6 );
        titles->addWidget( label( QStringLiteral( "wsEyebrow" ), tr( "STEP 2 · DISK" ) ) );
        titles->addWidget( label( QStringLiteral( "wsTitle" ), tr( "Where should WorkSuite go?" ) ) );
        auto* sub = label( QStringLiteral( "wsSubtitle" ),
                           tr( "WorkSuite OS uses the whole disk. Check that this is the right one." ) );
        sub->setWordWrap( true );
        titles->addWidget( sub );
        l->addLayout( titles );

        // The disk card (design: Inst3Disk): icon, the disk, its node. The stock device list stays the control,
        // borderless inside the card, so a computer with several disks can still choose.
        auto* devCard = new QFrame;
        devCard->setObjectName( QStringLiteral( "wsDevCard" ) );
        auto* dl = new QHBoxLayout( devCard );
        dl->setContentsMargins( 16, 0, 16, 0 );
        dl->setSpacing( 14 );
        devCard->setFixedHeight( 52 );
        dl->addWidget( iconLabel( QStringLiteral( "disk" ), QColor( "#C9D6EE" ), 22 ) );
        if ( m_drives )
        {
            m_drives->setParent( devCard );
            m_drives->setObjectName( QStringLiteral( "wsDeviceCombo" ) );
            m_drives->setAccessibleName( tr( "Storage device" ) );
            m_drives->setSizePolicy( QSizePolicy::Expanding, QSizePolicy::Fixed );
            dl->addWidget( m_drives, 1 );
            m_drives->show();
            m_node = label( QStringLiteral( "wsDevNode" ) );
            dl->addWidget( m_node );
            QObject::connect( m_drives, qOverload< int >( &QComboBox::currentIndexChanged ), this, [ this ] { refreshDevice(); } );
        }
        l->addWidget( devCard );

        // Erase disk: the one installation type (WSOS-INS: erase-only), shown selected.
        auto* card = new QFrame;
        card->setObjectName( QStringLiteral( "wsEraseCard" ) );
        auto* cl = new QHBoxLayout( card );
        cl->setContentsMargins( 18, 16, 18, 16 );
        cl->setSpacing( 14 );
        // The selected radio as the browser draws it (accent #1F6BFF): the only choice, so a mark, not a control.
        auto* radio = new QLabel;
        radio->setPixmap( radioMark() );
        radio->setFixedSize( 18, 18 );
        radio->setContentsMargins( 0, 0, 0, 0 );
        card->setAccessibleName( tr( "Erase disk" ) );
        cl->addWidget( radio, 0, Qt::AlignTop );
        auto* texts = new QVBoxLayout;
        texts->setSpacing( 4 );
        texts->addWidget( label( QStringLiteral( "wsCardTitle" ), tr( "Erase disk" ) ) );
        auto* desc = label( QStringLiteral( "wsCardText" ),
                            tr( "Deletes <b style=\"color:#FFB98A\">all data</b> on the selected device." ) );
        desc->setTextFormat( Qt::RichText );
        texts->addWidget( desc );
        cl->addLayout( texts, 1 );
        l->addWidget( card );

        auto* preview = new QFrame;
        preview->setObjectName( QStringLiteral( "wsPreview" ) );
        auto* g = new QGridLayout( preview );
        g->setContentsMargins( 18, 18, 18, 18 );
        g->setHorizontalSpacing( 14 );
        g->setVerticalSpacing( 8 );
        g->setColumnMinimumWidth( 0, 56 );
        g->setColumnStretch( 1, 1 );
        g->addWidget( label( QStringLiteral( "wsBeforeLabel" ), tr( "Before" ) ), 0, 0 );
        m_beforeBar = new Bar;
        g->addWidget( m_beforeBar, 0, 1 );
        m_beforeLegend = new QHBoxLayout;
        m_beforeLegend->setSpacing( 24 );
        g->addLayout( m_beforeLegend, 1, 1 );
        auto* afterLabel = label( QStringLiteral( "wsAfterLabel" ), tr( "After" ) );
        g->addWidget( afterLabel, 2, 0 );
        m_afterBar = new Bar;
        g->addWidget( m_afterBar, 2, 1 );
        m_afterLegend = new QHBoxLayout;
        m_afterLegend->setSpacing( 24 );
        g->addLayout( m_afterLegend, 3, 1 );
        g->setRowMinimumHeight( 1, 18 );
        afterLabel->setContentsMargins( 0, 8, 0, 0 );
        m_afterBar->setContentsMargins( 0, 8, 0, 0 );
        g->setRowMinimumHeight( 2, 30 );
        l->addWidget( preview );
        l->addStretch();
        return w;
    }

    QWidget* buildEncryption()
    {
        auto* w = new QWidget;
        auto* l = new QVBoxLayout( w );
        l->setContentsMargins( 0, 0, 0, 0 );
        l->setSpacing( 22 );

        auto* titles = new QVBoxLayout;
        titles->setSpacing( 6 );
        titles->addWidget( label( QStringLiteral( "wsEyebrow" ), tr( "STEP 2 · ENCRYPTION" ) ) );
        titles->addWidget( label( QStringLiteral( "wsTitle" ), tr( "Encrypt your disk?" ) ) );
        auto* sub = label( QStringLiteral( "wsSubtitle" ),
                           tr( "Keeps your files safe if the computer is lost or stolen. You'll type this passphrase "
                               "each time it starts." ) );
        sub->setWordWrap( true );
        sub->setMaximumWidth( 640 );
        titles->addWidget( sub );
        l->addLayout( titles );

        auto* choices = new QHBoxLayout;
        choices->setSpacing( 12 );
        auto* group = new QButtonGroup( w );
        auto makeCard = [ & ]( const QString& kind, const QColor& color, const QString& title, const QString& text ) {
            auto* b = new QPushButton;
            b->setObjectName( QStringLiteral( "wsChoiceCard" ) );
            b->setCheckable( true );
            b->setAccessibleName( title );
            b->setCursor( Qt::PointingHandCursor );
            auto* bl = new QHBoxLayout( b );
            bl->setContentsMargins( 18, 18, 18, 18 );
            bl->setSpacing( 14 );
            bl->addWidget( iconLabel( kind, color, 26 ), 0, Qt::AlignTop );
            auto* tl = new QVBoxLayout;
            tl->setSpacing( 4 );
            auto* t1 = label( QStringLiteral( "wsCardTitle" ), title );
            auto* t2 = label( QStringLiteral( "wsCardHint" ), text );
            t1->setAttribute( Qt::WA_TransparentForMouseEvents );
            t2->setAttribute( Qt::WA_TransparentForMouseEvents );
            tl->addWidget( t1 );
            tl->addWidget( t2 );
            bl->addLayout( tl, 1 );
            b->setMinimumHeight( 82 );
            group->addButton( b );
            choices->addWidget( b, 1 );
            return b;
        };
        m_on = makeCard( QStringLiteral( "lock" ), QColor( "#18D4F0" ), tr( "Encrypt (recommended)" ), tr( "LUKS2 full-disk encryption" ) );
        m_off = makeCard( QStringLiteral( "unlock" ), QColor( "#8FA3C8" ), tr( "Don't encrypt" ), tr( "Faster setup, no passphrase at startup" ) );
        QObject::connect( m_on, &QPushButton::clicked, this, [ this ] {
            if ( m_encrypt && !m_encrypt->isChecked() )
            {
                m_encrypt->setChecked( true );
            }
            refreshEncryption();
        } );
        QObject::connect( m_off, &QPushButton::clicked, this, [ this ] {
            if ( m_encrypt && m_encrypt->isChecked() )
            {
                m_encrypt->setChecked( false );
            }
            refreshEncryption();
        } );
        l->addLayout( choices );

        m_passCard = new QFrame;
        m_passCard->setObjectName( QStringLiteral( "wsPassCard" ) );
        auto* pl = new QVBoxLayout( m_passCard );
        pl->setContentsMargins( 20, 20, 20, 20 );
        pl->setSpacing( 14 );
        auto* fields = new QGridLayout;
        fields->setHorizontalSpacing( 12 );
        fields->setVerticalSpacing( 6 );
        fields->setColumnStretch( 0, 1 );
        fields->setColumnStretch( 1, 1 );
        auto* l1 = label( QStringLiteral( "wsFieldLabel" ), tr( "Passphrase" ) );
        auto* l2 = label( QStringLiteral( "wsFieldLabel" ), tr( "Confirm passphrase" ) );
        fields->addWidget( l1, 0, 0 );
        fields->addWidget( l2, 0, 1 );
        if ( m_pass && m_confirm )
        {
            m_pass->setParent( m_passCard );
            m_confirm->setParent( m_passCard );
            m_pass->setFixedHeight( 44 );
            m_confirm->setFixedHeight( 44 );
            fields->setRowMinimumHeight( 1, 44 );
            m_pass->setAccessibleName( tr( "Passphrase" ) );
            m_confirm->setAccessibleName( tr( "Confirm passphrase" ) );
            l1->setBuddy( m_pass );
            l2->setBuddy( m_confirm );
            fields->addWidget( m_pass, 1, 0 );
            fields->addWidget( m_confirm, 1, 1 );
        }
        pl->addLayout( fields );
        auto* bars = new QHBoxLayout;
        bars->setSpacing( 6 );
        for ( int i = 0; i < 4; ++i )
        {
            auto* b = new QFrame;
            b->setObjectName( QStringLiteral( "wsStrengthBar" ) );
            b->setFixedHeight( 4 );
            bars->addWidget( b, 1 );
            m_bars << b;
        }
        pl->addLayout( bars );
        auto* msgRow = new QHBoxLayout;
        m_msg = label( QStringLiteral( "wsPassMsg" ) );
        m_strength = label( QStringLiteral( "wsPassStrength" ) );
        msgRow->addWidget( m_msg, 1 );
        msgRow->addWidget( m_strength );
        pl->addLayout( msgRow );
        l->addWidget( m_passCard );

        m_warn = new QFrame;
        m_warn->setObjectName( QStringLiteral( "wsWarnBox" ) );
        auto* wl = new QHBoxLayout( m_warn );
        wl->setContentsMargins( 16, 14, 16, 14 );
        wl->setSpacing( 12 );
        wl->addWidget( iconLabel( QStringLiteral( "warn" ), QColor( "#FFB98A" ), 18 ), 0, Qt::AlignTop );
        auto* wt = label( QStringLiteral( "wsWarnText" ),
                          tr( "If you forget this passphrase, the recovery key (shown at the end of install) is the "
                              "only way back in." ) );
        wt->setWordWrap( true );
        wl->addWidget( wt, 1 );
        l->addWidget( m_warn );
        l->addStretch();
        return w;
    }

    static QPixmap radioMark()
    {
        const qreal dpr = qApp ? qApp->devicePixelRatio() : 1.0;
        QPixmap pm( QSize( 18, 18 ) * dpr );
        pm.setDevicePixelRatio( dpr );
        pm.fill( Qt::transparent );
        QPainter p( &pm );
        p.setRenderHint( QPainter::Antialiasing );
        p.setPen( Qt::NoPen );
        p.setBrush( QColor( "#1F6BFF" ) );
        p.drawEllipse( QRectF( 1, 1, 16, 16 ) );
        p.setBrush( QColor( "#FFFFFF" ) );
        p.drawEllipse( QRectF( 5.5, 5.5, 7, 7 ) );
        return pm;
    }

    // Widgets ChoicePage creates once it knows the devices (the erase choice and its swap list): taken when they exist.
    void adoptStock()
    {
        if ( !m_erase || !m_swap )
        {
            for ( auto* w : m_page->findChildren< QWidget* >() )
            {
                if ( QByteArray( w->metaObject()->className() ).endsWith( "PrettyRadioButton" ) && w->findChild< QComboBox* >() )
                {
                    m_erase = w->findChild< QRadioButton* >();
                    m_swap = w->findChild< QComboBox* >();
                }
            }
            // The Swap list stays with the stock widgets (hidden): partition.conf's default swap choice applies.
        }
        if ( m_erase && !m_erase->isChecked() )
        {
            m_erase->click();   // erase is the only installation type (partition.conf); keep it chosen
        }
        // Device list entries as the design writes them: "vda · 40.00 GiB (/dev/vda)", no icon.
        if ( m_drives && m_drives->model() && !m_drives->model()->inherits( "QIdentityProxyModel" ) )
        {
            auto* proxy = new DeviceNames( m_drives );
            proxy->setSourceModel( m_drives->model() );
            const int current = m_drives->currentIndex();
            const bool blocked = m_drives->blockSignals( true );
            m_drives->setModel( proxy );
            m_drives->setCurrentIndex( current );
            m_drives->blockSignals( blocked );
            m_drives->setIconSize( QSize( 0, 0 ) );
        }
        refreshDevice();
    }

    // The node beside the disk name ("/dev/vda"); the drop-down arrow only when there is a choice.
    void refreshDevice()
    {
        if ( !m_drives || !m_node )
        {
            return;
        }
        QString node;
        if ( auto* proxy = qobject_cast< QIdentityProxyModel* >( m_drives->model() ) )
        {
            const QString src = proxy->sourceModel()->index( m_drives->currentIndex(), 0 ).data().toString();
            const int at = src.lastIndexOf( QStringLiteral( "(/dev/" ) );
            node = at >= 0 ? src.mid( at + 1 ).chopped( src.endsWith( QLatin1Char( ')' ) ) ? 1 : 0 ) : QString();
        }
        m_node->setText( node );
        const bool choice = m_drives->count() > 1;
        const QVariant was = m_drives->property( "wsChoice" );
        if ( !was.isValid() || was.toBool() != choice )
        {
            m_drives->setProperty( "wsChoice", choice );
            m_drives->setEnabled( choice );
            repolish( m_drives );
        }
    }

    void refreshEncryption()
    {
        const bool enc = m_encrypt && m_encrypt->isChecked();
        m_on->setChecked( enc );
        m_off->setChecked( !enc );
        m_passCard->setVisible( enc );
        m_warn->setVisible( enc );
        if ( enc && m_pass && m_confirm )
        {
            // The stock widget hides its fields until the box is ticked; here the card decides.
            m_pass->show();
            m_confirm->show();
        }
        const QString a = m_pass ? m_pass->text() : QString();
        const QString b = m_confirm ? m_confirm->text() : QString();
        const int score = WsStyle::passphraseScore( a );
        const QString names[] = { QStringLiteral( "—" ), tr( "Weak" ), tr( "Fair" ), tr( "Good" ), tr( "Strong" ) };
        static const char* const colors[] = { "#FF8A7A", "#FF8A7A", "#FFB98A", "#18D4F0", "#5FD39A" };
        for ( int i = 0; i < m_bars.count(); ++i )
        {
            m_bars[ i ]->setStyleSheet( QStringLiteral( "background: %1; border-radius: 2px;" )
                                            .arg( i < score ? QString::fromLatin1( colors[ score ] )
                                                            : QStringLiteral( "rgba(127,178,255,0.15)" ) ) );
        }
        m_strength->setText( tr( "Strength: %1" ).arg( names[ score ] ) );
        QString msg = tr( "At least 8 characters" );
        QString state = QStringLiteral( "hint" );
        if ( !b.isEmpty() && a != b )
        {
            msg = tr( "Passphrases do not match" );
            state = QStringLiteral( "bad" );
        }
        else if ( !b.isEmpty() && a == b && a.length() >= 8 )
        {
            msg = tr( "Passphrases match" );
            state = QStringLiteral( "good" );
        }
        m_msg->setText( msg );
        m_msg->setProperty( "wsState", state );
        repolish( m_msg );
        if ( m_confirm )
        {
            m_confirm->setProperty( "wsState", state );
            repolish( m_confirm );
        }
        setState( "encrypt", enc );
    }

    void refreshBars()
    {
        auto before = segmentsOf( barsModel( m_beforeFrame ), false );
        auto after = segmentsOf( barsModel( m_afterFrame ), true );
        QString sig;
        for ( const auto& s : before + after )
        {
            sig += s.kind + s.text + QLatin1Char( ';' );
        }
        sig += QString::number( before.count() );
        if ( sig == m_barsSig )
        {
            return;
        }
        m_barsSig = sig;
        m_beforeBar->setSegments( before );
        m_afterBar->setSegments( after );
        fillLegend( m_beforeLegend, before, false );
        fillLegend( m_afterLegend, after, true );
    }

    static void fillLegend( QHBoxLayout* l, const QList< Segment >& segs, bool swatches )
    {
        while ( auto* item = l->takeAt( 0 ) )
        {
            delete item->widget();
            delete item;
        }
        for ( const auto& s : segs )
        {
            auto* t = label( swatches ? QStringLiteral( "wsLegend" ) : QStringLiteral( "wsCaption" ), s.text );
            if ( swatches )
            {
                const QString c = s.kind == QLatin1String( "efi" ) ? QStringLiteral( "#FF9F5A" )
                    : s.kind == QLatin1String( "root" )            ? QStringLiteral( "#18D4F0" )
                    : s.kind == QLatin1String( "free" )            ? QStringLiteral( "rgba(127,178,255,0.25)" )
                                                                   : QStringLiteral( "#7FB2FF" );
                auto* row = new QWidget;
                auto* rl = new QHBoxLayout( row );
                rl->setContentsMargins( 0, 0, 0, 0 );
                rl->setSpacing( 6 );
                auto* sw = new QFrame;
                sw->setFixedSize( 10, 10 );
                sw->setStyleSheet( QStringLiteral( "background: %1; border-radius: 3px;" ).arg( c ) );
                rl->addWidget( sw );
                rl->addWidget( t );
                l->addWidget( row );
            }
            else
            {
                l->addWidget( t );
            }
        }
        l->addStretch();
    }

    void setSub( int sub )
    {
        m_sub = sub;
        m_disk->setVisible( sub == 0 );
        m_enc->setVisible( sub == 1 );
        if ( m_active )
        {
            setState( "subCount", 2 );
            setState( "subStep", sub );
            setState( "subNextOk", true );
        }
        if ( sub == 1 && m_encrypt && m_encrypt->isChecked() && m_pass )
        {
            m_pass->setFocus();
        }
    }

    void arrive()
    {
        if ( m_active )
        {
            return;
        }
        m_active = true;
        setGeometry( m_page->rect() );
        raise();
        // As WsPage.qml: coming back from a later step lands on the last sub-step.
        const int i = Calamares::ViewManager::instance() ? Calamares::ViewManager::instance()->currentStepIndex() : -1;
        const int last = stateValue( "lastStep", -1 ).toInt();
        setState( "lastStep", i );
        m_lastRequest = stateValue( "subRequest", QString() ).toString();
        setSub( i >= 0 && i < last ? 1 : 0 );
        refreshEncryption();
        m_timer.start();
    }

    void leave()
    {
        if ( !m_active )
        {
            return;
        }
        m_active = false;
        m_timer.stop();
        setState( "subCount", 0 );
        setState( "subStep", 0 );
    }

    void poll()
    {
        adoptStock();
        refreshBars();
        // The QML page left behind clears the shared sub-step state after this page arrived: report again.
        if ( stateValue( "subCount", 0 ).toInt() != 2 )
        {
            setSub( m_sub );
        }
        // The footer asks for the next or previous sub-step (calamares-navigation.qml).
        const QString r = stateValue( "subRequest", QString() ).toString();
        if ( r.isEmpty() || r == m_lastRequest )
        {
            return;
        }
        m_lastRequest = r;
        if ( r.startsWith( QLatin1String( "next:" ) ) && m_sub == 0 )
        {
            setSub( 1 );
        }
        else if ( r.startsWith( QLatin1String( "back:" ) ) && m_sub == 1 )
        {
            setSub( 0 );
        }
        else
        {
            setSub( m_sub );   // re-report, so the footer's guess is corrected
        }
    }

    QWidget* m_page;
    QPointer< QComboBox > m_drives, m_swap;
    QPointer< QRadioButton > m_erase;
    QLabel* m_node = nullptr;
    QPointer< QCheckBox > m_encrypt;
    QPointer< QLineEdit > m_pass, m_confirm;
    QPointer< QWidget > m_beforeFrame, m_afterFrame;
    QWidget* m_disk = nullptr;
    QWidget* m_enc = nullptr;
    QPushButton* m_on = nullptr;
    QPushButton* m_off = nullptr;
    QFrame* m_passCard = nullptr;
    QFrame* m_warn = nullptr;
    QList< QFrame* > m_bars;
    QLabel* m_msg = nullptr;
    QLabel* m_strength = nullptr;
    Bar* m_beforeBar = nullptr;
    Bar* m_afterBar = nullptr;
    QHBoxLayout* m_beforeLegend = nullptr;
    QHBoxLayout* m_afterLegend = nullptr;
    QString m_barsSig;
    QString m_lastRequest;
    QTimer m_timer;
    int m_sub = 0;
    bool m_active = false;
};

/* ------------------------------------------------------------------------------------------------------------
   Dialogs (design: Dialog kit, Quit dialog). */
struct DialogKind
{
    const char* icon;
    QColor color;
    const char* name;   // the badge's tint, by object property (stylesheet.qss)
};

DialogKind
kindOf( QMessageBox::Icon i )
{
    switch ( i )
    {
    case QMessageBox::Critical:
        return { "error", QColor( "#FF8A7A" ), "error" };
    case QMessageBox::Warning:
        return { "warn", QColor( "#FFB98A" ), "warning" };
    case QMessageBox::Information:
        return { "info", QColor( "#5FD39A" ), "info" };
    default:
        return { "question", QColor( "#7FB2FF" ), "question" };
    }
}

QString
plainTitle( QString s )
{
    s.remove( QRegularExpression( QStringLiteral( "<[^>]*>" ) ) );
    return s.trimmed();
}

// The card: badge and texts above, buttons in a darker band below.
struct Card
{
    QFrame* card;
    QVBoxLayout* texts;
    QHBoxLayout* buttons;
};

Card
buildCard( QDialog* d, const DialogKind& kind, bool large )
{
    if ( auto* old = d->layout() )
    {
        delete old;   // the widgets stay; they are placed again below
    }
    auto* outer = new QVBoxLayout( d );
    // Room for the shadow: DialogCancel 0 30px 80px rgba(0,0,0,0.6), DialogKit 0 24px 60px rgba(0,0,0,0.5).
    outer->setContentsMargins( 40, 24, 40, 56 );
    d->setProperty( "wsLarge", large );
    auto* card = new QFrame( d );
    card->setObjectName( QStringLiteral( "wsDlgCard" ) );
    auto* shadow = new QGraphicsDropShadowEffect( card );
    shadow->setBlurRadius( large ? 80 : 60 );
    shadow->setOffset( 0, large ? 30 : 24 );
    shadow->setColor( QColor( 0, 0, 0, large ? 153 : 128 ) );
    card->setGraphicsEffect( shadow );
    outer->addWidget( card );
    auto* cl = new QVBoxLayout( card );
    cl->setContentsMargins( 0, 0, 0, 0 );
    cl->setSpacing( 0 );
    auto* body = new QFrame;
    body->setObjectName( QStringLiteral( "wsDlgBody" ) );
    auto* bl = new QHBoxLayout( body );
    bl->setContentsMargins( large ? 28 : 24, large ? 28 : 24, large ? 28 : 24, large ? 22 : 20 );
    bl->setSpacing( large ? 18 : 16 );
    auto* badge = new QLabel;
    badge->setObjectName( QStringLiteral( "wsDlgBadge" ) );
    badge->setProperty( "kind", QString::fromLatin1( kind.name ) );
    badge->setProperty( "large", large );
    const int bs = large ? 48 : 44;
    badge->setFixedSize( bs, bs );
    badge->setAlignment( Qt::AlignCenter );
    badge->setPixmap( icon( QString::fromLatin1( kind.icon ), kind.color, large ? 26 : 24 ) );
    bl->addWidget( badge, 0, Qt::AlignTop );
    auto* texts = new QVBoxLayout;
    texts->setSpacing( large ? 8 : 6 );
    bl->addLayout( texts, 1 );
    cl->addWidget( body );
    auto* band = new QFrame;
    band->setObjectName( QStringLiteral( "wsDlgButtons" ) );
    auto* btn = new QHBoxLayout( band );
    btn->setContentsMargins( large ? 20 : 18, large ? 16 : 14, large ? 20 : 18, large ? 16 : 14 );
    band->setProperty( "large", large );
    btn->setSpacing( 10 );
    btn->addStretch();
    cl->addWidget( band );
    return { card, texts, btn };
}

void
setRole( QAbstractButton* b, const char* role )
{
    b->setProperty( "wsRole", QString::fromLatin1( role ) );
    repolish( b );
}

void
dimBehind( QWidget* d )
{
    QWidget* win = d->parentWidget() ? d->parentWidget()->window() : nullptr;
    if ( !win )
    {
        for ( auto* w : QApplication::topLevelWidgets() )
        {
            if ( w != d && w->objectName() == QLatin1String( "mainApp" ) && w->isVisible() )
            {
                win = w;
            }
        }
    }
    if ( !win )
    {
        return;
    }
    auto* dim = new QWidget( win );
    dim->setObjectName( QStringLiteral( "wsDlgDim" ) );
    dim->setAttribute( Qt::WA_StyledBackground );
    dim->setStyleSheet( QStringLiteral( "background: rgba(2,6,16,0.62);" ) );
    dim->setGeometry( win->rect() );
    dim->show();
    dim->raise();
    d->setProperty( "wsDim", QVariant::fromValue( static_cast< QObject* >( dim ) ) );
}

// QMessageBox fixes its own size again whenever its style or contents change (updateSize); this puts the design's back.
class SizeGuard : public QObject
{
public:
    using QObject::QObject;
    QSize target;

protected:
    bool eventFilter( QObject* o, QEvent* e ) override
    {
        if ( e->type() == QEvent::Resize && target.isValid() && static_cast< QWidget* >( o )->size() != target )
        {
            auto* d = static_cast< QWidget* >( o );
            QTimer::singleShot( 0, d, [ d, this ] {
                if ( d->size() != target )
                {
                    d->setFixedSize( target );
                }
            } );
        }
        return false;
    }
};

void
fitDialog( QDialog* d )
{
    // Set the design's width once the dialog's own showEvent has sized it, and keep it.
    QTimer::singleShot( 0, d, [ d ] {
        // DialogCancel's card is 460 px; DialogKit's cards are a column of its two-column grid, 576 px.
        const int w = ( d->property( "wsLarge" ).toBool() ? 460 : 576 ) + 80;
        auto* guard = static_cast< SizeGuard* >( d->findChild< QObject* >( QStringLiteral( "wsSizeGuard" ), Qt::FindDirectChildrenOnly ) );
        if ( !guard )
        {
            guard = new SizeGuard( d );
            guard->setObjectName( QStringLiteral( "wsSizeGuard" ) );
            d->installEventFilter( guard );
        }
        guard->target = QSize();
        d->setMinimumSize( 0, 0 );
        d->setMaximumSize( QWIDGETSIZE_MAX, QWIDGETSIZE_MAX );
        const int h = d->layout()->hasHeightForWidth() ? d->layout()->totalHeightForWidth( w ) : d->layout()->sizeHint().height();
        guard->target = QSize( w, h );
        d->setFixedSize( w, h );
        if ( auto* p = d->parentWidget() ? d->parentWidget()->window() : nullptr )
        {
            d->move( p->geometry().center() - QPoint( w / 2, h / 2 ) );
        }
    } );
}

// A card button that clicks a dialog's own (hidden) button: the dialog's result and signals stay its own.
QPushButton*
proxyButton( QDialog* d, const Card& c, QAbstractButton* real, const QString& text, const char* role, bool isDefault )
{
    auto* b = new QPushButton( text );
    b->setCursor( Qt::PointingHandCursor );
    setRole( b, role );
    b->setAutoDefault( false );
    b->setDefault( isDefault );
    QPointer< QAbstractButton > target( real );
    QObject::connect( b, &QPushButton::clicked, d, [ target ] {
        if ( target )
        {
            target->click();
        }
    } );
    c.buttons->addWidget( b );
    if ( isDefault )
    {
        b->setFocus();
    }
    return b;
}

// Hides a message box's own widgets (icon, labels, button box, check box): now and after its showEvent re-shows them.
void
hideStock( QMessageBox* mb, QWidget* card )
{
    auto hide = [ mb, card ] {
        for ( auto* w : mb->findChildren< QWidget* >( QString(), Qt::FindDirectChildrenOnly ) )
        {
            if ( w != card && !w->isWindow() )
            {
                w->hide();
            }
        }
    };
    hide();
    QTimer::singleShot( 0, mb, hide );
}

void
styleMessageBox( QMessageBox* mb )
{
    auto kind = kindOf( mb->icon() );
    QString title = plainTitle( mb->windowTitle() );
    QString text = mb->text();
    QList< QAbstractButton* > buttons = mb->buttons();
    QAbstractButton* primary = mb->defaultButton();

    // Calamares' "Cancel Installation?" (ViewManager::confirmCancelInstallation): the design's Quit dialog.
    const bool cancel = mb->icon() == QMessageBox::Question
        && mb->standardButtons() == ( QMessageBox::Yes | QMessageBox::No );
    bool large = false;
    if ( cancel )
    {
        large = true;
        kind = { "warn", QColor( "#FFB98A" ), "warning" };   // DialogCancel: the warning badge
        title = tr( "Quit the installer?" );
        text = stateValue( "installFailed", false ).toBool()
            ? tr( "The installation did not finish. You can start again any time from the boot menu." )
            : tr( "Nothing has been installed yet, and your disk hasn't changed. You can start again any time from "
                  "the boot menu." );
    }

    // QMessageBox lays out, re-wraps and re-parents its own label and buttons whenever it shows (Qt 6.8), so they
    // stay where it keeps them, hidden; the card shows copies, and its buttons click the real ones.
    auto* infoL = mb->findChild< QLabel* >( QStringLiteral( "qt_msgbox_informativelabel" ) );
    const QString info = cancel || !infoL ? QString() : infoL->text();
    Card c = buildCard( mb, kind, large );
    hideStock( mb, c.card );
    auto* t = label( QStringLiteral( "wsDlgTitle" ), title );
    t->setProperty( "large", large );
    t->setWordWrap( true );
    c.texts->addWidget( t );
    for ( const QString& body : { text, info } )
    {
        if ( body.isEmpty() )
        {
            continue;
        }
        auto* b = label( QStringLiteral( "wsDlgText" ), body );
        b->setTextFormat( Qt::AutoText );
        b->setWordWrap( true );
        b->setTextInteractionFlags( Qt::TextSelectableByMouse );
        c.texts->addWidget( b );
    }

    QList< QPair< QAbstractButton*, QString > > order;   // the real button and the design's label for it
    QAbstractButton* primaryButton = nullptr;
    if ( cancel && mb->button( QMessageBox::No ) && mb->button( QMessageBox::Yes ) )
    {
        // Keep installing (the safe default, primary) then Quit installer (destructive outline).
        order = { { mb->button( QMessageBox::No ), tr( "Keep installing" ) },
                  { mb->button( QMessageBox::Yes ), tr( "Quit installer" ) } };
        primaryButton = mb->button( QMessageBox::No );
    }
    else
    {
        // Secondary actions first, the primary (default, else the accepting) one last.
        if ( !primary )
        {
            for ( auto* b : buttons )
            {
                const auto role = mb->buttonRole( b );
                if ( role == QMessageBox::AcceptRole || role == QMessageBox::YesRole )
                {
                    primary = b;
                }
            }
        }
        if ( !primary && !buttons.isEmpty() )
        {
            primary = buttons.last();
        }
        buttons.removeAll( primary );
        if ( primary )
        {
            buttons.append( primary );
        }
        for ( auto* b : buttons )
        {
            order.append( { b, b->text().remove( QLatin1Char( '&' ) ) } );
        }
        primaryButton = primary;
    }
    for ( const auto& [ real, text ] : order )
    {
        const bool isPrimary = real == primaryButton;
        // DialogKit: a warning's primary goes ahead despite it (#D9452B); DialogCancel's Quit is the outlined danger.
        const char* role = isPrimary ? ( mb->icon() == QMessageBox::Warning && !cancel ? "caution" : "primary" )
            : cancel                 ? "danger"
                                     : "secondary";
        proxyButton( mb, c, real, text, role, isPrimary );
    }
}

void
styleErrorDialog( QDialog* d )
{
    const DialogKind kind = { "error", QColor( "#FF8A7A" ), "error" };
    auto* icon = d->findChild< QLabel* >( QStringLiteral( "iconLabel" ) );
    auto* heading = d->findChild< QLabel* >( QStringLiteral( "headingLabel" ) );
    auto* info = d->findChild< QLabel* >( QStringLiteral( "informativeTextLabel" ) );
    auto* detailsLabel = d->findChild< QLabel* >( QStringLiteral( "label" ) );
    auto* details = d->findChild< QTextBrowser* >( QStringLiteral( "detailsBrowser" ) );
    auto* paste = d->findChild< QLabel* >( QStringLiteral( "offerWebPasteLabel" ) );
    auto* box = d->findChild< QDialogButtonBox* >( QStringLiteral( "buttonBox" ) );
    auto* detailsWidget = d->findChild< QWidget* >( QStringLiteral( "detailsWidget" ) );
    const bool showDetails = details && !details->toPlainText().trimmed().isEmpty();
    const bool showPaste = paste && !paste->isHidden();

    Card c = buildCard( d, kind, false );
    if ( icon )
    {
        icon->hide();
    }
    auto* t = label( QStringLiteral( "wsDlgTitle" ), heading ? plainTitle( heading->text() ) : d->windowTitle() );
    t->setWordWrap( true );
    c.texts->addWidget( t );
    if ( heading )
    {
        heading->hide();
    }
    if ( info )
    {
        info->setObjectName( QStringLiteral( "wsDlgText" ) );
        info->setWordWrap( true );
        info->setParent( c.card );
        c.texts->addWidget( info );
        info->show();
    }
    if ( detailsLabel )
    {
        detailsLabel->hide();
    }
    if ( details )
    {
        details->setObjectName( QStringLiteral( "wsDlgCode" ) );
        details->setParent( c.card );
        // DialogKit's code line: as tall as its text, at most 120 px.
        details->document()->setDocumentMargin( 0 );
        details->setVerticalScrollBarPolicy( Qt::ScrollBarAsNeeded );
        details->setFixedHeight( qMin( 120, int( details->document()->size().height() ) + 14 ) );
        c.texts->addWidget( details );
        details->setVisible( showDetails );
    }
    if ( detailsWidget )
    {
        detailsWidget->hide();
    }
    if ( paste )
    {
        paste->setObjectName( QStringLiteral( "wsDlgText" ) );
        paste->setParent( c.card );
        paste->setWordWrap( true );
        c.texts->addWidget( paste );
        paste->setVisible( showPaste );
    }
    if ( box )
    {
        // As message boxes: the box keeps its buttons (hidden), the card shows ones that click them.
        QList< QAbstractButton* > buttons = box->buttons();
        QAbstractButton* primary = nullptr;
        for ( auto* b : buttons )
        {
            const auto role = box->buttonRole( b );
            if ( role == QDialogButtonBox::AcceptRole || role == QDialogButtonBox::YesRole )
            {
                primary = b;
            }
        }
        if ( !primary && !buttons.isEmpty() )
        {
            primary = buttons.last();
        }
        buttons.removeAll( primary );
        if ( primary )
        {
            buttons.append( primary );
        }
        for ( auto* b : buttons )
        {
            proxyButton( d, c, b, b->text().remove( QLatin1Char( '&' ) ), b == primary ? "primary" : "secondary", b == primary );
        }
        box->hide();
    }
}
}  // namespace

namespace WsStyle
{
int
passphraseScore( const QString& a )
{
    static const QRegularExpression digit( QStringLiteral( "[0-9]" ) );
    static const QRegularExpression other( QStringLiteral( "[^A-Za-z0-9]" ) );
    const int s = int( a.length() >= 8 ) + int( a.length() >= 12 ) + int( a.contains( digit ) ) + int( a.contains( other ) );
    return qMin( 4, s );
}

QString
sizeText( qint64 bytes )
{
    const double mib = double( bytes ) / ( 1024.0 * 1024.0 );
    if ( mib < 1024.0 )
    {
        return QStringLiteral( "%1 MiB" ).arg( qRound( mib ) );
    }
    return QStringLiteral( "%1 GiB" ).arg( mib / 1024.0, 0, 'f', 2 );
}

void
styleChoicePage( QWidget* page )
{
    if ( !page || page->property( "wsStyled" ).toBool() )
    {
        return;
    }
    page->setProperty( "wsStyled", true );
    page->setAttribute( Qt::WA_StyledBackground );
    new DiskPage( page );
}

static bool
isStyledDialog( QWidget* w )
{
    return qobject_cast< QMessageBox* >( w ) || w->inherits( "Calamares::ErrorDialog" );
}

void
prepareDialog( QWidget* w )
{
    if ( !isStyledDialog( w ) || w->property( "wsPrepared" ).toBool() || w->testAttribute( Qt::WA_WState_Created ) )
    {
        return;
    }
    w->setProperty( "wsPrepared", true );
    w->setWindowFlag( Qt::FramelessWindowHint, true );
    w->setAttribute( Qt::WA_TranslucentBackground );
}

void
styleDialog( QWidget* w )
{
    if ( !isStyledDialog( w ) )
    {
        return;
    }
    auto* d = static_cast< QDialog* >( w );
    if ( w->property( "wsStyled" ).toBool() )
    {
        if ( w->property( "wsReshow" ).toBool() )
        {
            w->setProperty( "wsReshow", false );
            dimBehind( d );
            fitDialog( d );
        }
        return;
    }
    d->setProperty( "wsStyled", true );
    if ( auto* mb = qobject_cast< QMessageBox* >( w ) )
    {
        styleMessageBox( mb );
    }
    else
    {
        styleErrorDialog( d );
    }
    repolish( d );
    dimBehind( d );
    fitDialog( d );
}

void
dialogHidden( QWidget* w )
{
    if ( auto* dim = qobject_cast< QWidget* >( w->property( "wsDim" ).value< QObject* >() ) )
    {
        w->setProperty( "wsDim", QVariant() );
        dim->deleteLater();
    }
    // Shown again (a dialog that is reused): dim again then.
    if ( w->property( "wsStyled" ).toBool() )
    {
        w->setProperty( "wsReshow", true );
    }
}
}  // namespace WsStyle

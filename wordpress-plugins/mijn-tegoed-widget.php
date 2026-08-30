<?php
/**
 * Plugin Name: Mijn Tegoed Widget
 * Description: Zwevende knop (linksonder) die het loyaltyaccount ("Mijn Tegoed") opent in een uitklappaneel — geen aparte pagina nodig, werkt op elke pagina van de site.
 * Version: 1.0.0
 * Author: Het Strand & Zomers
 * Text Domain: mijn-tegoed-widget
 *
 * ============================================================================
 * INSTALLATIE
 * ============================================================================
 * 1. Zet dit bestand in: /wp-content/plugins/mijn-tegoed-widget.php
 *    (los bestand, geen map nodig — WordPress herkent dit automatisch)
 * 2. WordPress-admin → Plugins → activeer "Mijn Tegoed Widget"
 * 3. WordPress-admin → Instellingen → "Mijn Tegoed" → kies het juiste
 *    merk voor DEZE website (Het Strand of Zomers) en stel eventueel de
 *    positie bij (zie hieronder waarom dat nodig kan zijn)
 *
 * Dezelfde pluginbestand kan op BEIDE websites (het-strand.nl en
 * zomersbeachclub.nl) geïnstalleerd worden — alleen de instelling
 * "Merk" hoeft per site anders te staan.
 *
 * LET OP — POSITIONERING: op het-strand.nl staat al een andere,
 * bestaande zwevende knop linksonder (de cadeaukaart-widget). Deze
 * nieuwe knop staat standaard er een stukje boven, zodat ze elkaar niet
 * overlappen — bij "Verticale afstand" in de instellingen kun je dit
 * fijn afstemmen als het nog niet helemaal goed uitlijnt.
 * ============================================================================
 */

if (!defined('ABSPATH')) {
    exit; // Direct aanroepen van dit bestand niet toestaan.
}

class MijnTegoedWidget
{
    private const OPTION_BRAND = 'mijn_tegoed_widget_brand';
    private const OPTION_BOTTOM_OFFSET = 'mijn_tegoed_widget_bottom_offset';
    private const PORTAL_BASE_URL = 'https://loyalty-platform-live.vercel.app/portal';

    public function __construct()
    {
        add_action('admin_menu', [$this, 'registerSettingsPage']);
        add_action('admin_init', [$this, 'registerSettings']);
        add_action('wp_footer', [$this, 'renderWidget']);
    }

    // -- Instellingenscherm ---------------------------------------------------

    public function registerSettingsPage(): void
    {
        add_options_page(
            'Mijn Tegoed Widget',
            'Mijn Tegoed',
            'manage_options',
            'mijn-tegoed-widget',
            [$this, 'renderSettingsPage']
        );
    }

    public function registerSettings(): void
    {
        register_setting('mijn_tegoed_widget_group', self::OPTION_BRAND, [
            'type' => 'string',
            'default' => 'het-strand',
            'sanitize_callback' => function ($value) {
                return in_array($value, ['het-strand', 'zomers'], true) ? $value : 'het-strand';
            },
        ]);
        register_setting('mijn_tegoed_widget_group', self::OPTION_BOTTOM_OFFSET, [
            'type' => 'integer',
            'default' => 100,
            'sanitize_callback' => 'absint',
        ]);
    }

    public function renderSettingsPage(): void
    {
        $brand = get_option(self::OPTION_BRAND, 'het-strand');
        $offset = get_option(self::OPTION_BOTTOM_OFFSET, 100);
        ?>
        <div class="wrap">
            <h1>Mijn Tegoed Widget</h1>
            <p>Deze instelling bepaalt welk merk (huisstijl + naam) getoond wordt in de zwevende Mijn Tegoed-knop op déze website.</p>
            <form method="post" action="options.php">
                <?php settings_fields('mijn_tegoed_widget_group'); ?>
                <table class="form-table">
                    <tr>
                        <th scope="row"><label for="mijn_tegoed_brand">Merk</label></th>
                        <td>
                            <select name="<?php echo esc_attr(self::OPTION_BRAND); ?>" id="mijn_tegoed_brand">
                                <option value="het-strand" <?php selected($brand, 'het-strand'); ?>>Het Strand</option>
                                <option value="zomers" <?php selected($brand, 'zomers'); ?>>Zomers Beachclub &amp; Brewery</option>
                            </select>
                        </td>
                    </tr>
                    <tr>
                        <th scope="row"><label for="mijn_tegoed_offset">Verticale afstand vanaf onderkant (px)</label></th>
                        <td>
                            <input type="number" name="<?php echo esc_attr(self::OPTION_BOTTOM_OFFSET); ?>" id="mijn_tegoed_offset" value="<?php echo esc_attr($offset); ?>" min="0" step="10" style="width:100px;">
                            <p class="description">Verhoog dit getal als de knop overlapt met een andere, al bestaande zwevende knop (bijv. de cadeaukaart-widget) linksonder op de site.</p>
                        </td>
                    </tr>
                </table>
                <?php submit_button(); ?>
            </form>
        </div>
        <?php
    }

    // -- De widget zelf: knop + uitklappaneel ---------------------------------

    public function renderWidget(): void
    {
        $brand = get_option(self::OPTION_BRAND, 'het-strand');
        $offset = (int) get_option(self::OPTION_BOTTOM_OFFSET, 100);
        $portalUrl = self::PORTAL_BASE_URL . '?brand=' . urlencode($brand);
        $brandLabel = $brand === 'zomers' ? 'Zomers Beachclub & Brewery' : 'Het Strand';
        ?>
        <style>
            #mtw-launcher {
                position: fixed;
                left: 24px;
                bottom: <?php echo esc_attr($offset); ?>px;
                z-index: 99998;
                background: #1b3a5c;
                color: #ffffff;
                border: none;
                border-radius: 30px;
                padding: 14px 22px;
                font-size: 14px;
                font-weight: 600;
                font-family: -apple-system, 'Inter', sans-serif;
                cursor: pointer;
                box-shadow: 0 4px 16px rgba(27,58,92,0.3);
                display: flex;
                align-items: center;
                gap: 8px;
            }
            #mtw-launcher:hover { background: #0e1c2a; }
            #mtw-overlay {
                display: none;
                position: fixed;
                inset: 0;
                background: rgba(14,28,42,0.5);
                z-index: 99999;
                align-items: stretch;
                justify-content: stretch;
                padding: 0;
            }
            #mtw-overlay.mtw-open { display: flex; }
            #mtw-panel {
                background: #f6f3ec;
                width: 100%;
                max-width: none;
                height: 100%;
                max-height: none;
                border-radius: 0;
                overflow: hidden;
                display: flex;
                flex-direction: column;
                box-shadow: none;
            }
            @media (min-width: 600px) {
                #mtw-overlay { align-items: center; justify-content: center; padding: 20px; }
                #mtw-panel { width: 100%; max-width: 420px; height: auto; max-height: 80vh; border-radius: 20px; box-shadow: 0 -4px 30px rgba(0,0,0,0.2); }
            }
            #mtw-panel-header {
                display: flex;
                justify-content: space-between;
                align-items: center;
                padding: 14px 18px;
                background: #0e1c2a;
                color: #ffffff;
                font-family: Georgia, serif;
                font-size: 15px;
                flex-shrink: 0;
            }
            #mtw-close-btn {
                background: none;
                border: none;
                color: rgba(255,255,255,0.7);
                font-size: 22px;
                line-height: 1;
                cursor: pointer;
                padding: 4px 8px;
            }
            #mtw-iframe-wrap { flex: 1; overflow-y: auto; -webkit-overflow-scrolling: touch; }
            #mtw-iframe { width: 100%; border: none; display: block; }
        </style>

        <button id="mtw-launcher" aria-haspopup="dialog" aria-controls="mtw-overlay">
            <span>Mijn Tegoed</span>
        </button>

        <div id="mtw-overlay" role="dialog" aria-modal="true" aria-label="Mijn Tegoed">
            <div id="mtw-panel">
                <div id="mtw-panel-header">
                    <span><?php echo esc_html($brandLabel); ?> — Mijn Tegoed</span>
                    <button id="mtw-close-btn" aria-label="Sluiten">&times;</button>
                </div>
                <div id="mtw-iframe-wrap">
                    <iframe id="mtw-iframe" src="about:blank" data-src="<?php echo esc_url($portalUrl); ?>" title="Mijn Tegoed" style="height:500px;"></iframe>
                </div>
            </div>
        </div>

        <script>
        (function () {
            var launcher = document.getElementById('mtw-launcher');
            var overlay = document.getElementById('mtw-overlay');
            var closeBtn = document.getElementById('mtw-close-btn');
            var iframe = document.getElementById('mtw-iframe');
            var iframeWrap = document.getElementById('mtw-iframe-wrap');
            var loaded = false;

            function openWidget() {
                overlay.classList.add('mtw-open');
                if (!loaded) {
                    iframe.src = iframe.getAttribute('data-src');
                    loaded = true;
                }
            }
            function closeWidget() {
                overlay.classList.remove('mtw-open');
            }

            launcher.addEventListener('click', openWidget);
            closeBtn.addEventListener('click', closeWidget);
            overlay.addEventListener('click', function (e) {
                if (e.target === overlay) closeWidget();
            });

            // Iframe past zijn eigen hoogte aan (zelfde mechanisme als de
            // Mijn Tegoed-pagina zelf), begrensd tot de paneelhoogte —
            // hier ook een INTERNE scroll toegestaan (in tegenstelling
            // tot een volledige pagina-embed), want dit is een popup,
            // geen hele pagina.
            window.addEventListener('message', function (event) {
                if (event.data && event.data.type === 'mijn-tegoed-resize') {
                    iframe.style.height = event.data.height + 'px';
                }
                // Bij een tab- of schermwissel binnen de portal kan de
                // inhoud korter worden dan waar het paneel toevallig
                // intern gescrold stond — dat gaf een wit gat bovenin
                // totdat er handmatig omhoog gescrold werd. De portal
                // stuurt dit bericht bij elke wissel; wij zetten de
                // interne scroll van het paneel dan terug naar boven.
                if (event.data && event.data.type === 'mijn-tegoed-scroll-top') {
                    if (iframeWrap) iframeWrap.scrollTop = 0;
                }
            });
        })();
        </script>
        <?php
    }
}

new MijnTegoedWidget();

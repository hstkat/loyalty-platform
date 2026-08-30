<?php
/**
 * Plugin Name: Cadeaukaart Widget
 * Description: Zwevende knop die een cadeaukaart-koopformulier opent in een uitklappaneel (bedrag kiezen, ontvanger invullen, doorgaan naar Mollie) — geen aparte pagina nodig.
 * Version: 1.0.0
 * Author: Het Strand & Zomers
 * Text Domain: gift-card-widget
 *
 * ============================================================================
 * INSTALLATIE
 * ============================================================================
 * 1. Zet dit bestand in: /wp-content/plugins/gift-card-widget.php
 *    (los bestand, geen map nodig — WordPress herkent dit automatisch)
 * 2. WordPress-admin → Plugins → activeer "Cadeaukaart Widget"
 * 3. WordPress-admin → Instellingen → "Cadeaukaart" → kies het juiste merk
 *    voor DEZE website en stel eventueel de positie bij
 *
 * Dezelfde pluginbestand kan op BEIDE websites (het-strand.nl en
 * zomersbeachclub.nl) geïnstalleerd worden — alleen de instelling "Merk"
 * hoeft per site anders te staan. Beide merken verkopen dezelfde
 * cadeaukaart (één gedeeld systeem, geen aparte kaarten per merk) — het
 * merk bepaalt alleen de kleuren/naam die de koper te zien krijgt.
 *
 * LET OP — POSITIONERING: staat er al een andere zwevende knop op de
 * site (bijv. de Mijn Tegoed-widget, of een oudere/losse
 * cadeaukaart-knop)? Stel dan bij "Positie" en "Verticale afstand" in
 * dat deze knop er niet overheen valt.
 * ============================================================================
 */

if (!defined('ABSPATH')) {
    exit; // Direct aanroepen van dit bestand niet toestaan.
}

class GiftCardWidget
{
    private const OPTION_BRAND = 'gift_card_widget_brand';
    private const OPTION_BOTTOM_OFFSET = 'gift_card_widget_bottom_offset';
    private const OPTION_POSITION = 'gift_card_widget_position';
    private const ORG_ID = 'ab51a93c-43a2-40cd-8635-f8522f68a8c8';
    private const BUY_BASE_URL = 'https://loyalty-platform-live.vercel.app/gift-cards/buy/';

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
            'Cadeaukaart Widget',
            'Cadeaukaart',
            'manage_options',
            'gift-card-widget',
            [$this, 'renderSettingsPage']
        );
    }

    public function registerSettings(): void
    {
        register_setting('gift_card_widget_group', self::OPTION_BRAND, [
            'type' => 'string',
            'default' => 'het-strand',
            'sanitize_callback' => function ($value) {
                return in_array($value, ['het-strand', 'zomers'], true) ? $value : 'het-strand';
            },
        ]);
        register_setting('gift_card_widget_group', self::OPTION_BOTTOM_OFFSET, [
            'type' => 'integer',
            'default' => 24,
            'sanitize_callback' => 'absint',
        ]);
        register_setting('gift_card_widget_group', self::OPTION_POSITION, [
            'type' => 'string',
            'default' => 'left',
            'sanitize_callback' => function ($value) {
                return in_array($value, ['left', 'right'], true) ? $value : 'left';
            },
        ]);
    }

    public function renderSettingsPage(): void
    {
        $brand = get_option(self::OPTION_BRAND, 'het-strand');
        $offset = get_option(self::OPTION_BOTTOM_OFFSET, 24);
        $position = get_option(self::OPTION_POSITION, 'left');
        ?>
        <div class="wrap">
            <h1>Cadeaukaart Widget</h1>
            <p>Deze instelling bepaalt welk merk (huisstijl + naam) getoond wordt in de zwevende cadeaukaart-knop op déze website. Beide merken verkopen dezelfde cadeaukaart — dit verandert alleen de kleuren en naam die de koper ziet.</p>
            <form method="post" action="options.php">
                <?php settings_fields('gift_card_widget_group'); ?>
                <table class="form-table">
                    <tr>
                        <th scope="row"><label for="gift_card_brand">Merk</label></th>
                        <td>
                            <select name="<?php echo esc_attr(self::OPTION_BRAND); ?>" id="gift_card_brand">
                                <option value="het-strand" <?php selected($brand, 'het-strand'); ?>>Het Strand</option>
                                <option value="zomers" <?php selected($brand, 'zomers'); ?>>Zomers Beachclub &amp; Brewery</option>
                            </select>
                        </td>
                    </tr>
                    <tr>
                        <th scope="row"><label for="gift_card_position">Positie</label></th>
                        <td>
                            <select name="<?php echo esc_attr(self::OPTION_POSITION); ?>" id="gift_card_position">
                                <option value="left" <?php selected($position, 'left'); ?>>Linksonder</option>
                                <option value="right" <?php selected($position, 'right'); ?>>Rechtsonder</option>
                            </select>
                            <p class="description">Staat er al een andere zwevende knop (bijv. Mijn Tegoed) aan één kant? Zet deze dan aan de andere kant.</p>
                        </td>
                    </tr>
                    <tr>
                        <th scope="row"><label for="gift_card_offset">Verticale afstand vanaf onderkant (px)</label></th>
                        <td>
                            <input type="number" name="<?php echo esc_attr(self::OPTION_BOTTOM_OFFSET); ?>" id="gift_card_offset" value="<?php echo esc_attr($offset); ?>" min="0" step="10" style="width:100px;">
                            <p class="description">Verhoog dit getal als de knop overlapt met een andere, al bestaande zwevende knop aan dezelfde kant van het scherm.</p>
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
        $offset = (int) get_option(self::OPTION_BOTTOM_OFFSET, 24);
        $position = get_option(self::OPTION_POSITION, 'left');
        $side = $position === 'right' ? 'right' : 'left';
        $buyUrl = self::BUY_BASE_URL . self::ORG_ID . '?brand=' . urlencode($brand);
        $brandLabel = $brand === 'zomers' ? 'Zomers Beachclub & Brewery' : 'Het Strand';
        $accent = $brand === 'zomers' ? '#497a9d' : '#c47a45';
        ?>
        <style>
            #gcw-launcher {
                position: fixed;
                <?php echo esc_attr($side); ?>: 24px;
                bottom: <?php echo esc_attr($offset); ?>px;
                z-index: 99998;
                background: <?php echo esc_attr($accent); ?>;
                color: #ffffff;
                border: none;
                border-radius: 30px;
                padding: 14px 22px;
                font-size: 14px;
                font-weight: 600;
                font-family: -apple-system, 'Inter', sans-serif;
                cursor: pointer;
                box-shadow: 0 4px 16px rgba(14,28,42,0.3);
                display: flex;
                align-items: center;
                gap: 8px;
            }
            #gcw-launcher:hover { filter: brightness(0.92); }
            #gcw-overlay {
                display: none;
                position: fixed;
                inset: 0;
                background: rgba(14,28,42,0.5);
                z-index: 99999;
                align-items: stretch;
                justify-content: stretch;
                padding: 0;
            }
            #gcw-overlay.gcw-open { display: flex; }
            #gcw-panel {
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
                #gcw-overlay { align-items: center; justify-content: center; padding: 20px; }
                #gcw-panel { width: 100%; max-width: 460px; height: auto; max-height: 85vh; border-radius: 20px; box-shadow: 0 -4px 30px rgba(0,0,0,0.2); }
            }
            #gcw-panel-header {
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
            #gcw-close-btn {
                background: none;
                border: none;
                color: rgba(255,255,255,0.7);
                font-size: 22px;
                line-height: 1;
                cursor: pointer;
                padding: 4px 8px;
            }
            #gcw-iframe-wrap { flex: 1; overflow-y: auto; -webkit-overflow-scrolling: touch; }
            #gcw-iframe { width: 100%; border: none; display: block; }
        </style>

        <button id="gcw-launcher" aria-haspopup="dialog" aria-controls="gcw-overlay">
            <span>🎁 Cadeaukaart kopen</span>
        </button>

        <div id="gcw-overlay" role="dialog" aria-modal="true" aria-label="Cadeaukaart kopen">
            <div id="gcw-panel">
                <div id="gcw-panel-header">
                    <span><?php echo esc_html($brandLabel); ?> — Cadeaukaart kopen</span>
                    <button id="gcw-close-btn" aria-label="Sluiten">&times;</button>
                </div>
                <div id="gcw-iframe-wrap">
                    <iframe id="gcw-iframe" src="about:blank" data-src="<?php echo esc_url($buyUrl); ?>" title="Cadeaukaart kopen" style="height:560px;"></iframe>
                </div>
            </div>
        </div>

        <script>
        (function () {
            var launcher = document.getElementById('gcw-launcher');
            var overlay = document.getElementById('gcw-overlay');
            var closeBtn = document.getElementById('gcw-close-btn');
            var iframe = document.getElementById('gcw-iframe');
            var loaded = false;

            function openWidget() {
                overlay.classList.add('gcw-open');
                if (!loaded) {
                    iframe.src = iframe.getAttribute('data-src');
                    loaded = true;
                }
            }
            function closeWidget() {
                overlay.classList.remove('gcw-open');
            }

            launcher.addEventListener('click', openWidget);
            closeBtn.addEventListener('click', closeWidget);
            overlay.addEventListener('click', function (e) {
                if (e.target === overlay) closeWidget();
            });

            // Iframe past zijn eigen hoogte aan aan de inhoud (bedrag
            // kiezen, "Anders…" veld tonen, foutmeldingen) — zelfde
            // mechanisme als de Mijn Tegoed-widget.
            window.addEventListener('message', function (event) {
                if (event.data && event.data.type === 'gift-card-buy-resize') {
                    iframe.style.height = event.data.height + 'px';
                }
            });
        })();
        </script>
        <?php
    }
}

new GiftCardWidget();

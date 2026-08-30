import { Injectable, NotFoundException } from '@nestjs/common';
import { randomBytes } from 'crypto';
import { PrismaService } from '../prisma/prisma.service';
import { GoogleWalletService } from '../common/google-wallet.service';

/**
 * Verbindt het bestaande, tot nu toe ongebruikte `WalletPass`-model met
 * de daadwerkelijke Google Wallet-API. Bewust GEEN nieuw
 * saldo/puntenmodel — alles wordt live opgehaald uit de bestaande
 * Wallet/Customer-tabellen op het moment van aanmaken/bijwerken; de
 * Wallet-pas zelf is uitsluitend een presentatie- en identificatielaag.
 */
@Injectable()
export class WalletPassService {
  constructor(
    private prisma: PrismaService,
    private googleWallet: GoogleWalletService,
  ) {}

  /**
   * Geeft de "Voeg toe aan Google Wallet"-link terug voor deze klant —
   * maakt bij de eerste keer een WalletPass-record + bijbehorend
   * Google-object aan; bij een volgende aanroep wordt het bestaande
   * object gewoon bijgewerkt met de actuele stand (nooit een tweede
   * pas voor dezelfde klant).
   */
  async getOrCreateGoogleWalletLink(orgId: string, customerId: string): Promise<{ saveUrl: string } | { saveUrl: null; reason: string }> {
    if (!this.googleWallet.isConfigured()) {
      return { saveUrl: null, reason: 'Google Wallet is nog niet ingesteld voor deze organisatie.' };
    }

    const customer = await this.prisma.customer.findFirst({
      where: { id: customerId, organizationId: orgId, deletedAt: null },
      include: { wallet: true, tier: true, organization: true },
    });
    if (!customer) throw new NotFoundException('Klant niet gevonden');

    let wallet = customer.wallet;
    if (!wallet) wallet = await this.prisma.wallet.create({ data: { organizationId: orgId, customerId } });

    let walletPass = await this.prisma.walletPass.findFirst({ where: { walletId: wallet.id, passType: 'google' } });
    if (!walletPass) {
      // Zelfde beveiligingsprincipe als de fysieke loyaltykaarten en
      // kadobonnen: een apart, willekeurig token — nooit het
      // database-ID van de klant of de wallet zelf.
      const serialNumber = randomBytes(16).toString('base64url');
      walletPass = await this.prisma.walletPass.create({
        data: { walletId: wallet.id, passType: 'google', serialNumber, status: 'not_installed' },
      });
    }

    await this.googleWallet.ensureLoyaltyClass(customer.organization.slug, customer.organization.name);
    const ok = await this.googleWallet.upsertLoyaltyObject(customer.organization.slug, {
      serialNumber: walletPass.serialNumber,
      firstName: customer.firstName || 'Gast',
      tierName: customer.tier?.name ?? null,
      balance: Number(wallet.availableBalance),
      points: Number(wallet.availableBalance), // dit platform gebruikt euro-tegoed als primair saldo; punten-weergave op de pas is hetzelfde getal totdat een apart puntenmodel wordt toegevoegd
    });

    if (!ok) {
      return { saveUrl: null, reason: 'Kon de Google Wallet-pas niet aanmaken/bijwerken — probeer het later opnieuw.' };
    }

    const saveUrl = this.googleWallet.buildSaveLink(customer.organization.slug, walletPass.serialNumber);
    if (!saveUrl) {
      return { saveUrl: null, reason: 'Kon geen opslaglink genereren.' };
    }

    await this.prisma.walletPass.update({ where: { id: walletPass.id }, data: { lastPushedAt: new Date() } });
    return { saveUrl };
  }

  /**
   * Best-effort bijwerken van een al geïnstalleerde pas — wordt
   * aangeroepen na saldowijzigingen (zie WalletService). Faalt bewust
   * stil (geen exception) als er geen pas is of Google niet is
   * ingesteld: de boeking zelf mag hier nooit door mislukken.
   */
  async pushUpdateForWallet(walletId: string): Promise<void> {
    if (!this.googleWallet.isConfigured()) return;

    const walletPass = await this.prisma.walletPass.findFirst({ where: { walletId, passType: 'google', status: { not: 'removed' } } });
    if (!walletPass) return;

    const wallet = await this.prisma.wallet.findUnique({
      where: { id: walletId },
      include: { customer: { include: { tier: true, organization: true } } },
    });
    if (!wallet) return;

    try {
      const ok = await this.googleWallet.upsertLoyaltyObject(wallet.customer.organization.slug, {
        serialNumber: walletPass.serialNumber,
        firstName: wallet.customer.firstName || 'Gast',
        tierName: wallet.customer.tier?.name ?? null,
        balance: Number(wallet.availableBalance),
        points: Number(wallet.availableBalance),
      });
      if (ok) await this.prisma.walletPass.update({ where: { id: walletPass.id }, data: { lastPushedAt: new Date() } });
    } catch {
      // Bewust stil — een mislukte pas-update mag nooit de onderliggende boeking beïnvloeden.
    }
  }
}

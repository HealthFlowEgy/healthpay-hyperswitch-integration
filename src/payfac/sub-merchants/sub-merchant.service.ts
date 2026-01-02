import { Injectable, Logger, HttpException, HttpStatus } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository } from 'typeorm';
import { ConfigService } from '@nestjs/config';
import { SubMerchant, SubMerchantStatus, KycStatus } from '../entities/sub-merchant.entity';
import { MerchantCategory } from '../entities/merchant-category.entity';
import { KycDocument, DocumentStatus } from '../entities/kyc-document.entity';
import { KycDocumentType } from '../entities/kyc-document-type.entity';
import { PricingPlan } from '../entities/pricing-plan.entity';
import { Bank } from '../entities/bank.entity';
import { NotificationService } from './notification.service';
import { StorageService } from './storage.service';
import * as crypto from 'crypto';
import { nanoid } from 'nanoid';

/**
 * Sub-Merchant Management Service
 * 
 * Handles:
 * - Sub-merchant onboarding
 * - KYC document management
 * - API key generation
 * - Status management
 * - Configuration
 */

export interface CreateSubMerchantDto {
  // Business Info
  businessName: string;
  businessNameAr?: string;
  tradeName?: string;
  tradeNameAr?: string;
  categoryCode: string;
  
  // Legal Info
  legalEntityType?: string;
  taxRegistrationNumber?: string;
  commercialRegistrationNumber?: string;
  commercialRegistrationGovernorate?: string;
  syndicateLicenseNumber?: string;
  edaLicenseNumber?: string;
  
  // Contact
  contactPersonName: string;
  contactPersonTitle?: string;
  contactPersonNationalId?: string;
  email: string;
  phone: string;
  secondaryPhone?: string;
  
  // Address
  addressLine1: string;
  addressLine2?: string;
  city: string;
  governorate: string;
  postalCode?: string;
  
  // Banking
  bankSwiftCode?: string;
  bankAccountNumber?: string;
  bankAccountName?: string;
  bankBranchName?: string;
  iban?: string;
  instapayIpa?: string;
  
  // Payout Preferences
  payoutMethod?: string;
  settlementCycle?: string;
  
  // Metadata
  metadata?: Record<string, any>;
}

export interface UpdateSubMerchantDto {
  businessName?: string;
  businessNameAr?: string;
  email?: string;
  phone?: string;
  addressLine1?: string;
  city?: string;
  governorate?: string;
  bankAccountNumber?: string;
  bankAccountName?: string;
  iban?: string;
  instapayIpa?: string;
  payoutMethod?: string;
  metadata?: Record<string, any>;
}

export interface UploadDocumentDto {
  documentTypeCode: string;
  file: Express.Multer.File;
  documentNumber?: string;
  issueDate?: Date;
  expiryDate?: string;
  issuingAuthority?: string;
}

@Injectable()
export class SubMerchantService {
  private readonly logger = new Logger(SubMerchantService.name);

  constructor(
    @InjectRepository(SubMerchant)
    private readonly subMerchantRepo: Repository<SubMerchant>,
    @InjectRepository(MerchantCategory)
    private readonly categoryRepo: Repository<MerchantCategory>,
    @InjectRepository(KycDocument)
    private readonly kycDocumentRepo: Repository<KycDocument>,
    @InjectRepository(KycDocumentType)
    private readonly kycDocTypeRepo: Repository<KycDocumentType>,
    @InjectRepository(PricingPlan)
    private readonly pricingPlanRepo: Repository<PricingPlan>,
    @InjectRepository(Bank)
    private readonly bankRepo: Repository<Bank>,
    private readonly configService: ConfigService,
    private readonly notificationService: NotificationService,
    private readonly storageService: StorageService,
  ) {}

  /**
   * Create a new sub-merchant (onboarding)
   */
  async createSubMerchant(dto: CreateSubMerchantDto): Promise<{
    subMerchant: SubMerchant;
    apiKey: string;
    publishableKey: string;
    requiredDocuments: KycDocumentType[];
  }> {
    // Validate category
    const category = await this.categoryRepo.findOne({
      where: { code: dto.categoryCode },
    });

    if (!category) {
      throw new HttpException('Invalid merchant category', HttpStatus.BAD_REQUEST);
    }

    // Check for duplicate email
    const existingEmail = await this.subMerchantRepo.findOne({
      where: { email: dto.email },
    });

    if (existingEmail) {
      throw new HttpException('Email already registered', HttpStatus.CONFLICT);
    }

    // Get bank if provided
    let bank: Bank | null = null;
    if (dto.bankSwiftCode) {
      bank = await this.bankRepo.findOne({
        where: { swiftCode: dto.bankSwiftCode },
      });
    }

    // Get default pricing plan
    const defaultPlan = await this.pricingPlanRepo.findOne({
      where: { isDefault: true },
    });

    // Generate merchant code
    const merchantCode = await this.generateMerchantCode(dto.categoryCode);

    // Generate API credentials
    const { apiKey, apiKeyHash, apiKeyPrefix } = this.generateApiKey();
    const publishableKey = this.generatePublishableKey();
    const { webhookSecret, webhookSecretHash } = this.generateWebhookSecret();

    // Create sub-merchant
    const subMerchant = this.subMerchantRepo.create({
      parentMerchantId: this.configService.get<string>('MASTER_MERCHANT_ID'),
      merchantCode,
      
      // Business Info
      businessName: dto.businessName,
      businessNameAr: dto.businessNameAr,
      tradeName: dto.tradeName,
      tradeNameAr: dto.tradeNameAr,
      categoryId: category.id,
      
      // Legal Info
      legalEntityType: dto.legalEntityType,
      taxRegistrationNumber: dto.taxRegistrationNumber,
      commercialRegistrationNumber: dto.commercialRegistrationNumber,
      commercialRegistrationGovernorate: dto.commercialRegistrationGovernorate,
      syndicateLicenseNumber: dto.syndicateLicenseNumber,
      edaLicenseNumber: dto.edaLicenseNumber,
      
      // Contact
      contactPersonName: dto.contactPersonName,
      contactPersonTitle: dto.contactPersonTitle,
      contactPersonNationalId: dto.contactPersonNationalId,
      email: dto.email,
      phone: this.formatEgyptPhone(dto.phone),
      secondaryPhone: dto.secondaryPhone ? this.formatEgyptPhone(dto.secondaryPhone) : null,
      
      // Address
      addressLine1: dto.addressLine1,
      addressLine2: dto.addressLine2,
      city: dto.city,
      governorate: dto.governorate,
      postalCode: dto.postalCode,
      country: 'EG',
      
      // Banking
      bankId: bank?.id,
      bankAccountNumber: dto.bankAccountNumber,
      bankAccountName: dto.bankAccountName,
      bankBranchName: dto.bankBranchName,
      iban: dto.iban,
      instapayIpa: dto.instapayIpa,
      
      // Configuration
      pricingPlanId: defaultPlan?.id,
      settlementCycle: dto.settlementCycle || 'D+1',
      payoutMethod: dto.payoutMethod || 'bank_transfer',
      
      // Limits (defaults based on category)
      dailyLimit: category.code === 'hospital' ? 500000 : 100000,
      monthlyLimit: category.code === 'hospital' ? 15000000 : 3000000,
      singleTransactionLimit: category.code === 'hospital' ? 100000 : 50000,
      
      // API Credentials
      apiKeyHash,
      apiKeyPrefix,
      publishableKey,
      webhookSecretHash,
      
      // Default enabled payment methods
      enabledPaymentMethods: ['card', 'fawry', 'opay', 'meeza', 'instapay'],
      
      // Status
      status: SubMerchantStatus.PENDING_KYC,
      kycStatus: KycStatus.PENDING,
      
      // Metadata
      metadata: dto.metadata || {},
    });

    await this.subMerchantRepo.save(subMerchant);

    // Get required KYC documents for this category
    const requiredDocuments = await this.getRequiredDocuments(category.code);

    // Send welcome notification
    await this.notificationService.sendWelcomeEmail(subMerchant, requiredDocuments);

    this.logger.log(`Created sub-merchant ${merchantCode} for ${dto.businessName}`);

    return {
      subMerchant,
      apiKey, // Only returned once!
      publishableKey,
      requiredDocuments,
    };
  }

  /**
   * Get sub-merchant by ID
   */
  async getSubMerchantById(id: string): Promise<SubMerchant> {
    const subMerchant = await this.subMerchantRepo.findOne({
      where: { id },
      relations: ['category', 'bank', 'pricingPlan'],
    });

    if (!subMerchant) {
      throw new HttpException('Sub-merchant not found', HttpStatus.NOT_FOUND);
    }

    return subMerchant;
  }

  /**
   * Get sub-merchant by API key
   */
  async getSubMerchantByApiKey(apiKey: string): Promise<SubMerchant> {
    const prefix = apiKey.substring(0, 10);
    const hash = this.hashApiKey(apiKey);

    const subMerchant = await this.subMerchantRepo.findOne({
      where: { apiKeyPrefix: prefix, apiKeyHash: hash },
    });

    if (!subMerchant) {
      throw new HttpException('Invalid API key', HttpStatus.UNAUTHORIZED);
    }

    if (subMerchant.status !== SubMerchantStatus.ACTIVE) {
      throw new HttpException(
        `Sub-merchant is ${subMerchant.status}`,
        HttpStatus.FORBIDDEN,
      );
    }

    return subMerchant;
  }

  /**
   * Update sub-merchant
   */
  async updateSubMerchant(id: string, dto: UpdateSubMerchantDto): Promise<SubMerchant> {
    const subMerchant = await this.getSubMerchantById(id);

    // Update fields
    Object.assign(subMerchant, {
      ...dto,
      phone: dto.phone ? this.formatEgyptPhone(dto.phone) : subMerchant.phone,
    });

    return this.subMerchantRepo.save(subMerchant);
  }

  /**
   * Upload KYC document
   */
  async uploadKycDocument(
    subMerchantId: string,
    dto: UploadDocumentDto,
  ): Promise<KycDocument> {
    const subMerchant = await this.getSubMerchantById(subMerchantId);

    // Get document type
    const docType = await this.kycDocTypeRepo.findOne({
      where: { code: dto.documentTypeCode },
    });

    if (!docType) {
      throw new HttpException('Invalid document type', HttpStatus.BAD_REQUEST);
    }

    // Check if document already exists
    const existing = await this.kycDocumentRepo.findOne({
      where: {
        subMerchantId,
        documentTypeId: docType.id,
        status: DocumentStatus.PENDING,
      },
    });

    if (existing) {
      // Delete old pending document
      await this.kycDocumentRepo.remove(existing);
    }

    // Upload file to storage
    const fileUrl = await this.storageService.uploadFile(
      dto.file,
      `kyc/${subMerchantId}/${dto.documentTypeCode}`,
    );

    // Create document record
    const document = this.kycDocumentRepo.create({
      subMerchantId,
      documentTypeId: docType.id,
      fileName: dto.file.originalname,
      fileUrl,
      fileSizeBytes: dto.file.size,
      mimeType: dto.file.mimetype,
      documentNumber: dto.documentNumber,
      issueDate: dto.issueDate,
      expiryDate: dto.expiryDate ? new Date(dto.expiryDate) : null,
      issuingAuthority: dto.issuingAuthority,
      status: DocumentStatus.PENDING,
    });

    await this.kycDocumentRepo.save(document);

    // Update sub-merchant KYC status
    if (subMerchant.kycStatus === KycStatus.PENDING) {
      subMerchant.kycStatus = KycStatus.IN_REVIEW;
      subMerchant.status = SubMerchantStatus.KYC_IN_REVIEW;
      subMerchant.kycSubmittedAt = new Date();
      await this.subMerchantRepo.save(subMerchant);
    }

    // Check if all required documents are uploaded
    await this.checkKycCompletion(subMerchantId);

    return document;
  }

  /**
   * Get KYC documents for sub-merchant
   */
  async getKycDocuments(subMerchantId: string): Promise<{
    documents: KycDocument[];
    required: KycDocumentType[];
    status: KycStatus;
  }> {
    const subMerchant = await this.getSubMerchantById(subMerchantId);

    const documents = await this.kycDocumentRepo.find({
      where: { subMerchantId },
      relations: ['documentType'],
    });

    const required = await this.getRequiredDocuments(subMerchant.category?.code);

    return {
      documents,
      required,
      status: subMerchant.kycStatus,
    };
  }

  /**
   * Approve KYC document (admin)
   */
  async approveDocument(
    documentId: string,
    approvedBy: string,
  ): Promise<KycDocument> {
    const document = await this.kycDocumentRepo.findOne({
      where: { id: documentId },
      relations: ['subMerchant'],
    });

    if (!document) {
      throw new HttpException('Document not found', HttpStatus.NOT_FOUND);
    }

    document.status = DocumentStatus.APPROVED;
    document.verifiedAt = new Date();
    document.verifiedBy = approvedBy;

    await this.kycDocumentRepo.save(document);

    // Check if all documents are approved
    await this.checkKycCompletion(document.subMerchantId);

    return document;
  }

  /**
   * Reject KYC document (admin)
   */
  async rejectDocument(
    documentId: string,
    rejectedBy: string,
    reason: string,
  ): Promise<KycDocument> {
    const document = await this.kycDocumentRepo.findOne({
      where: { id: documentId },
      relations: ['subMerchant'],
    });

    if (!document) {
      throw new HttpException('Document not found', HttpStatus.NOT_FOUND);
    }

    document.status = DocumentStatus.REJECTED;
    document.verifiedBy = rejectedBy;
    document.rejectionReason = reason;

    await this.kycDocumentRepo.save(document);

    // Update sub-merchant status
    const subMerchant = document.subMerchant;
    subMerchant.kycStatus = KycStatus.REJECTED;
    subMerchant.status = SubMerchantStatus.KYC_REJECTED;
    subMerchant.kycRejectionReason = reason;
    await this.subMerchantRepo.save(subMerchant);

    // Notify merchant
    await this.notificationService.sendKycRejectionEmail(subMerchant, reason);

    return document;
  }

  /**
   * Activate sub-merchant (after KYC approval)
   */
  async activateSubMerchant(
    subMerchantId: string,
    activatedBy: string,
  ): Promise<SubMerchant> {
    const subMerchant = await this.getSubMerchantById(subMerchantId);

    if (subMerchant.kycStatus !== KycStatus.APPROVED) {
      throw new HttpException('KYC not approved', HttpStatus.BAD_REQUEST);
    }

    subMerchant.status = SubMerchantStatus.ACTIVE;
    subMerchant.activatedAt = new Date();
    subMerchant.activatedBy = activatedBy;

    await this.subMerchantRepo.save(subMerchant);

    // Notify merchant
    await this.notificationService.sendActivationEmail(subMerchant);

    this.logger.log(`Activated sub-merchant ${subMerchant.merchantCode}`);

    return subMerchant;
  }

  /**
   * Suspend sub-merchant
   */
  async suspendSubMerchant(
    subMerchantId: string,
    suspendedBy: string,
    reason: string,
  ): Promise<SubMerchant> {
    const subMerchant = await this.getSubMerchantById(subMerchantId);

    subMerchant.status = SubMerchantStatus.SUSPENDED;
    subMerchant.suspendedAt = new Date();
    subMerchant.suspendedBy = suspendedBy;
    subMerchant.suspensionReason = reason;

    await this.subMerchantRepo.save(subMerchant);

    // Notify merchant
    await this.notificationService.sendSuspensionEmail(subMerchant, reason);

    return subMerchant;
  }

  /**
   * Regenerate API key
   */
  async regenerateApiKey(subMerchantId: string): Promise<{ apiKey: string }> {
    const subMerchant = await this.getSubMerchantById(subMerchantId);

    const { apiKey, apiKeyHash, apiKeyPrefix } = this.generateApiKey();

    subMerchant.apiKeyHash = apiKeyHash;
    subMerchant.apiKeyPrefix = apiKeyPrefix;

    await this.subMerchantRepo.save(subMerchant);

    return { apiKey };
  }

  /**
   * Update webhook configuration
   */
  async updateWebhook(
    subMerchantId: string,
    webhookUrl: string,
  ): Promise<{ webhookSecret: string }> {
    const subMerchant = await this.getSubMerchantById(subMerchantId);

    const { webhookSecret, webhookSecretHash } = this.generateWebhookSecret();

    subMerchant.webhookUrl = webhookUrl;
    subMerchant.webhookSecretHash = webhookSecretHash;

    await this.subMerchantRepo.save(subMerchant);

    return { webhookSecret };
  }

  /**
   * Get sub-merchants (admin)
   */
  async getSubMerchants(
    status?: SubMerchantStatus,
    categoryCode?: string,
    governorate?: string,
    page: number = 1,
    limit: number = 20,
  ): Promise<{ subMerchants: SubMerchant[]; total: number }> {
    const where: any = {};

    if (status) where.status = status;
    if (governorate) where.governorate = governorate;
    if (categoryCode) {
      const category = await this.categoryRepo.findOne({ where: { code: categoryCode } });
      if (category) where.categoryId = category.id;
    }

    const [subMerchants, total] = await this.subMerchantRepo.findAndCount({
      where,
      relations: ['category'],
      order: { createdAt: 'DESC' },
      skip: (page - 1) * limit,
      take: limit,
    });

    return { subMerchants, total };
  }

  // ============================================================================
  // Private Helper Methods
  // ============================================================================

  private async generateMerchantCode(categoryCode: string): Promise<string> {
    const prefix = categoryCode.substring(0, 2).toUpperCase();
    
    // Get last merchant code for this category
    const lastMerchant = await this.subMerchantRepo
      .createQueryBuilder('sm')
      .where('sm.merchantCode LIKE :pattern', { pattern: `SM-${prefix}-%` })
      .orderBy('sm.createdAt', 'DESC')
      .getOne();

    let sequence = 1;
    if (lastMerchant) {
      const lastNum = parseInt(lastMerchant.merchantCode.split('-')[2], 10);
      sequence = lastNum + 1;
    }

    return `SM-${prefix}-${String(sequence).padStart(5, '0')}`;
  }

  private generateApiKey(): {
    apiKey: string;
    apiKeyHash: string;
    apiKeyPrefix: string;
  } {
    const apiKey = `sk_live_${nanoid(32)}`;
    const apiKeyHash = this.hashApiKey(apiKey);
    const apiKeyPrefix = apiKey.substring(0, 10);

    return { apiKey, apiKeyHash, apiKeyPrefix };
  }

  private generatePublishableKey(): string {
    return `pk_live_${nanoid(24)}`;
  }

  private generateWebhookSecret(): {
    webhookSecret: string;
    webhookSecretHash: string;
  } {
    const webhookSecret = `whsec_${nanoid(32)}`;
    const webhookSecretHash = crypto
      .createHash('sha256')
      .update(webhookSecret)
      .digest('hex');

    return { webhookSecret, webhookSecretHash };
  }

  private hashApiKey(apiKey: string): string {
    return crypto.createHash('sha256').update(apiKey).digest('hex');
  }

  private formatEgyptPhone(phone: string): string {
    // Remove all non-digits
    let cleaned = phone.replace(/\D/g, '');

    // Handle different formats
    if (cleaned.startsWith('20')) {
      cleaned = cleaned.substring(2);
    } else if (cleaned.startsWith('002')) {
      cleaned = cleaned.substring(3);
    }

    // Ensure it starts with 0
    if (!cleaned.startsWith('0')) {
      cleaned = '0' + cleaned;
    }

    return cleaned;
  }

  private async getRequiredDocuments(categoryCode?: string): Promise<KycDocumentType[]> {
    const query = this.kycDocTypeRepo.createQueryBuilder('dt').where('dt.isRequired = true');

    if (categoryCode) {
      query.andWhere(
        '(dt.appliesToCategories IS NULL OR :category = ANY(dt.appliesToCategories))',
        { category: categoryCode },
      );
    }

    return query.getMany();
  }

  private async checkKycCompletion(subMerchantId: string): Promise<void> {
    const subMerchant = await this.subMerchantRepo.findOne({
      where: { id: subMerchantId },
      relations: ['category'],
    });

    if (!subMerchant) return;

    // Get required documents
    const required = await this.getRequiredDocuments(subMerchant.category?.code);

    // Get approved documents
    const approved = await this.kycDocumentRepo.find({
      where: {
        subMerchantId,
        status: DocumentStatus.APPROVED,
      },
      relations: ['documentType'],
    });

    const approvedTypes = approved.map(d => d.documentType.code);
    const allApproved = required.every(r => approvedTypes.includes(r.code));

    if (allApproved) {
      subMerchant.kycStatus = KycStatus.APPROVED;
      subMerchant.kycApprovedAt = new Date();
      subMerchant.status = SubMerchantStatus.PENDING_ACTIVATION;
      await this.subMerchantRepo.save(subMerchant);

      // Notify for activation
      await this.notificationService.sendKycApprovalEmail(subMerchant);
    }
  }
}

import { Injectable, Logger, HttpException, HttpStatus } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository } from 'typeorm';
import { ConfigService } from '@nestjs/config';
import { SubMerchant, SubMerchantStatus, KYCStatus } from '../entities/sub-merchant.entity';
import { MerchantCategory } from '../entities/merchant-category.entity';
import { KycDocument, KycDocumentStatus } from '../entities/kyc-document.entity';
import { KycDocumentType } from '../entities/kyc-document-type.entity';
import { KycVerificationLog } from '../entities/kyc-verification-log.entity';
import { PricingPlan } from '../entities/pricing-plan.entity';
import { Bank } from '../entities/bank.entity';
import { NotificationService } from './notification.service';
import { S3Service } from './s3.service';
import * as bcrypt from 'bcrypt';
import { nanoid } from 'nanoid';

/**
 * Sub-Merchant Onboarding Service
 * 
 * Handles:
 * - Sub-merchant registration
 * - KYC document upload and verification
 * - API key generation
 * - Activation workflow
 * 
 * Egyptian-specific features:
 * - Commercial Register validation
 * - Tax Card verification
 * - Pharmacy/Medical license checks
 * - National ID validation
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
  iban?: string;
  instapayIpa?: string;
  
  // Configuration
  settlementCycle?: string;
  payoutMethod?: string;
  
  // Metadata
  metadata?: Record<string, any>;
}

export interface UploadKycDocumentDto {
  documentTypeCode: string;
  file: Express.Multer.File;
  documentNumber?: string;
  issueDate?: Date;
  expiryDate?: Date;
  issuingAuthority?: string;
}

export interface SubMerchantResponse {
  id: string;
  merchantCode: string;
  businessName: string;
  status: SubMerchantStatus;
  kycStatus: KYCStatus;
  apiKey?: string;
  publishableKey?: string;
  requiredDocuments: string[];
}

@Injectable()
export class SubMerchantOnboardingService {
  private readonly logger = new Logger(SubMerchantOnboardingService.name);

  constructor(
    @InjectRepository(SubMerchant)
    private readonly subMerchantRepo: Repository<SubMerchant>,
    @InjectRepository(MerchantCategory)
    private readonly categoryRepo: Repository<MerchantCategory>,
    @InjectRepository(KycDocument)
    private readonly kycDocumentRepo: Repository<KycDocument>,
    @InjectRepository(KycDocumentType)
    private readonly kycDocTypeRepo: Repository<KycDocumentType>,
    @InjectRepository(KycVerificationLog)
    private readonly kycLogRepo: Repository<KycVerificationLog>,
    @InjectRepository(PricingPlan)
    private readonly pricingPlanRepo: Repository<PricingPlan>,
    @InjectRepository(Bank)
    private readonly bankRepo: Repository<Bank>,
    private readonly configService: ConfigService,
    private readonly notificationService: NotificationService,
    private readonly s3Service: S3Service,
  ) {}

  /**
   * Register a new sub-merchant
   */
  async registerSubMerchant(
    dto: CreateSubMerchantDto,
    parentMerchantId: string,
  ): Promise<SubMerchantResponse> {
    // Validate category
    const category = await this.categoryRepo.findOne({
      where: { code: dto.categoryCode },
    });

    if (!category) {
      throw new HttpException('Invalid business category', HttpStatus.BAD_REQUEST);
    }

    // Check for duplicate
    const existing = await this.subMerchantRepo.findOne({
      where: [
        { email: dto.email },
        { phone: dto.phone },
        { taxRegistrationNumber: dto.taxRegistrationNumber },
      ],
    });

    if (existing) {
      throw new HttpException(
        'A merchant with this email, phone, or tax number already exists',
        HttpStatus.CONFLICT,
      );
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
    const { apiKey, apiKeyHash, apiKeyPrefix, publishableKey } = this.generateApiCredentials();

    // Create sub-merchant
    const subMerchant = this.subMerchantRepo.create({
      parentMerchantId,
      merchantCode,
      businessName: dto.businessName,
      businessNameAr: dto.businessNameAr,
      tradeName: dto.tradeName,
      tradeNameAr: dto.tradeNameAr,
      categoryId: category.id,
      legalEntityType: dto.legalEntityType,
      taxRegistrationNumber: dto.taxRegistrationNumber,
      commercialRegistrationNumber: dto.commercialRegistrationNumber,
      commercialRegistrationGovernorate: dto.commercialRegistrationGovernorate,
      syndicateLicenseNumber: dto.syndicateLicenseNumber,
      edaLicenseNumber: dto.edaLicenseNumber,
      contactPersonName: dto.contactPersonName,
      contactPersonTitle: dto.contactPersonTitle,
      email: dto.email,
      phone: dto.phone,
      secondaryPhone: dto.secondaryPhone,
      addressLine1: dto.addressLine1,
      addressLine2: dto.addressLine2,
      city: dto.city,
      governorate: dto.governorate,
      postalCode: dto.postalCode,
      bankId: bank?.id,
      bankAccountNumber: dto.bankAccountNumber,
      bankAccountName: dto.bankAccountName,
      iban: dto.iban,
      instapayIpa: dto.instapayIpa,
      pricingPlanId: defaultPlan?.id,
      settlementCycle: dto.settlementCycle || 'D+1',
      payoutMethod: dto.payoutMethod || 'bank_transfer',
      apiKeyHash,
      apiKeyPrefix,
      publishableKey,
      enabledPaymentMethods: ['card', 'fawry', 'opay', 'meeza', 'instapay'],
      status: SubMerchantStatus.PENDING_KYC,
      kycStatus: KYCStatus.PENDING,
      metadata: dto.metadata || {},
    });

    await this.subMerchantRepo.save(subMerchant);

    // Log KYC initiation
    await this.kycLogRepo.save({
      subMerchantId: subMerchant.id,
      action: 'initiated',
      performedByType: 'merchant',
      notes: 'Registration completed, awaiting KYC documents',
    });

    // Send welcome email
    await this.notificationService.sendWelcomeEmail(subMerchant);

    // Get required documents
    const requiredDocs = await this.getRequiredDocuments(category.code);

    return {
      id: subMerchant.id,
      merchantCode: subMerchant.merchantCode,
      businessName: subMerchant.businessName,
      status: subMerchant.status,
      kycStatus: subMerchant.kycStatus,
      apiKey, // Only returned once during registration
      publishableKey,
      requiredDocuments: requiredDocs.map(d => d.code),
    };
  }

  /**
   * Upload KYC document
   */
  async uploadKycDocument(
    subMerchantId: string,
    dto: UploadKycDocumentDto,
  ): Promise<KycDocument> {
    const subMerchant = await this.subMerchantRepo.findOne({
      where: { id: subMerchantId },
    });

    if (!subMerchant) {
      throw new HttpException('Sub-merchant not found', HttpStatus.NOT_FOUND);
    }

    // Get document type
    const docType = await this.kycDocTypeRepo.findOne({
      where: { code: dto.documentTypeCode },
    });

    if (!docType) {
      throw new HttpException('Invalid document type', HttpStatus.BAD_REQUEST);
    }

    // Check for existing document of same type
    const existing = await this.kycDocumentRepo.findOne({
      where: {
        subMerchantId,
        documentTypeId: docType.id,
        status: KycDocumentStatus.PENDING,
      },
    });

    if (existing) {
      throw new HttpException(
        'A pending document of this type already exists',
        HttpStatus.CONFLICT,
      );
    }

    // Upload file to S3
    const s3Key = `kyc/${subMerchantId}/${dto.documentTypeCode}/${Date.now()}_${dto.file.originalname}`;
    const fileUrl = await this.s3Service.uploadFile(dto.file, s3Key);

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
      expiryDate: dto.expiryDate,
      issuingAuthority: dto.issuingAuthority,
      status: KycDocumentStatus.PENDING,
    });

    await this.kycDocumentRepo.save(document);

    // Log upload
    await this.kycLogRepo.save({
      subMerchantId,
      action: 'document_uploaded',
      performedByType: 'merchant',
      notes: `Uploaded ${docType.name}`,
      metadata: { documentId: document.id, documentType: dto.documentTypeCode },
    });

    // Check if all required documents are uploaded
    await this.checkKycCompleteness(subMerchantId);

    return document;
  }

  /**
   * Submit KYC for review
   */
  async submitKycForReview(subMerchantId: string): Promise<SubMerchant> {
    const subMerchant = await this.subMerchantRepo.findOne({
      where: { id: subMerchantId },
      relations: ['category'],
    });

    if (!subMerchant) {
      throw new HttpException('Sub-merchant not found', HttpStatus.NOT_FOUND);
    }

    if (subMerchant.status !== SubMerchantStatus.PENDING_KYC) {
      throw new HttpException(
        `Cannot submit KYC in status: ${subMerchant.status}`,
        HttpStatus.BAD_REQUEST,
      );
    }

    // Verify all required documents are uploaded
    const requiredDocs = await this.getRequiredDocuments(subMerchant.category?.code);
    const uploadedDocs = await this.kycDocumentRepo.find({
      where: { subMerchantId },
      relations: ['documentType'],
    });

    const uploadedCodes = uploadedDocs.map(d => d.documentType?.code);
    const missingDocs = requiredDocs.filter(r => !uploadedCodes.includes(r.code));

    if (missingDocs.length > 0) {
      throw new HttpException(
        `Missing required documents: ${missingDocs.map(d => d.name).join(', ')}`,
        HttpStatus.BAD_REQUEST,
      );
    }

    // Update status
    subMerchant.status = SubMerchantStatus.KYC_IN_REVIEW;
    subMerchant.kycStatus = KYCStatus.IN_REVIEW;
    subMerchant.kycSubmittedAt = new Date();

    await this.subMerchantRepo.save(subMerchant);

    // Log submission
    await this.kycLogRepo.save({
      subMerchantId,
      action: 'submitted',
      performedByType: 'merchant',
      notes: 'KYC submitted for review',
    });

    // Notify compliance team
    await this.notificationService.sendKycSubmissionAlert(subMerchant);

    return subMerchant;
  }

  /**
   * Approve KYC (admin action)
   */
  async approveKyc(
    subMerchantId: string,
    approvedBy: string,
    notes?: string,
  ): Promise<SubMerchant> {
    const subMerchant = await this.subMerchantRepo.findOne({
      where: { id: subMerchantId },
    });

    if (!subMerchant) {
      throw new HttpException('Sub-merchant not found', HttpStatus.NOT_FOUND);
    }

    if (subMerchant.status !== SubMerchantStatus.KYC_IN_REVIEW) {
      throw new HttpException(
        `Cannot approve KYC in status: ${subMerchant.status}`,
        HttpStatus.BAD_REQUEST,
      );
    }

    // Approve all pending documents
    await this.kycDocumentRepo.update(
      { subMerchantId, status: KycDocumentStatus.PENDING },
      { 
        status: KycDocumentStatus.APPROVED, 
        verifiedAt: new Date(),
        verifiedBy: approvedBy,
      },
    );

    // Update merchant status
    subMerchant.status = SubMerchantStatus.PENDING_ACTIVATION;
    subMerchant.kycStatus = KYCStatus.APPROVED;
    subMerchant.kycApprovedAt = new Date();
    subMerchant.kycApprovedBy = approvedBy;

    await this.subMerchantRepo.save(subMerchant);

    // Log approval
    await this.kycLogRepo.save({
      subMerchantId,
      action: 'approved',
      performedBy: approvedBy,
      performedByType: 'admin',
      notes: notes || 'KYC approved',
    });

    // Send approval notification
    await this.notificationService.sendKycApprovalEmail(subMerchant);

    return subMerchant;
  }

  /**
   * Reject KYC (admin action)
   */
  async rejectKyc(
    subMerchantId: string,
    rejectedBy: string,
    reason: string,
    rejectedDocuments?: string[],
  ): Promise<SubMerchant> {
    const subMerchant = await this.subMerchantRepo.findOne({
      where: { id: subMerchantId },
    });

    if (!subMerchant) {
      throw new HttpException('Sub-merchant not found', HttpStatus.NOT_FOUND);
    }

    // Reject specified documents
    if (rejectedDocuments && rejectedDocuments.length > 0) {
      await this.kycDocumentRepo.update(
        { id: In(rejectedDocuments) },
        { 
          status: KycDocumentStatus.REJECTED,
          verifiedAt: new Date(),
          verifiedBy: rejectedBy,
          rejectionReason: reason,
        },
      );
    }

    // Update merchant status
    subMerchant.status = SubMerchantStatus.KYC_REJECTED;
    subMerchant.kycStatus = KYCStatus.REJECTED;
    subMerchant.kycRejectionReason = reason;

    await this.subMerchantRepo.save(subMerchant);

    // Log rejection
    await this.kycLogRepo.save({
      subMerchantId,
      action: 'rejected',
      performedBy: rejectedBy,
      performedByType: 'admin',
      notes: reason,
      metadata: { rejectedDocuments },
    });

    // Send rejection notification
    await this.notificationService.sendKycRejectionEmail(subMerchant, reason);

    return subMerchant;
  }

  /**
   * Activate sub-merchant (admin action)
   */
  async activateSubMerchant(
    subMerchantId: string,
    activatedBy: string,
  ): Promise<SubMerchant> {
    const subMerchant = await this.subMerchantRepo.findOne({
      where: { id: subMerchantId },
    });

    if (!subMerchant) {
      throw new HttpException('Sub-merchant not found', HttpStatus.NOT_FOUND);
    }

    if (subMerchant.status !== SubMerchantStatus.PENDING_ACTIVATION) {
      throw new HttpException(
        `Cannot activate in status: ${subMerchant.status}`,
        HttpStatus.BAD_REQUEST,
      );
    }

    // Activate
    subMerchant.status = SubMerchantStatus.ACTIVE;
    subMerchant.activatedAt = new Date();
    subMerchant.activatedBy = activatedBy;

    await this.subMerchantRepo.save(subMerchant);

    // Log activation
    await this.kycLogRepo.save({
      subMerchantId,
      action: 'activated',
      performedBy: activatedBy,
      performedByType: 'admin',
      notes: 'Merchant activated',
    });

    // Send activation notification
    await this.notificationService.sendActivationEmail(subMerchant);

    return subMerchant;
  }

  /**
   * Get sub-merchant by ID
   */
  async getSubMerchantById(subMerchantId: string): Promise<SubMerchant> {
    return this.subMerchantRepo.findOne({
      where: { id: subMerchantId },
      relations: ['category', 'bank', 'pricingPlan'],
    });
  }

  /**
   * Get KYC documents for sub-merchant
   */
  async getKycDocuments(subMerchantId: string): Promise<KycDocument[]> {
    return this.kycDocumentRepo.find({
      where: { subMerchantId },
      relations: ['documentType'],
      order: { uploadedAt: 'DESC' },
    });
  }

  /**
   * Get KYC status summary
   */
  async getKycStatus(subMerchantId: string): Promise<{
    status: KYCStatus;
    submittedAt?: Date;
    approvedAt?: Date;
    rejectionReason?: string;
    documents: {
      type: string;
      status: KycDocumentStatus;
      uploadedAt: Date;
    }[];
    missingDocuments: string[];
  }> {
    const subMerchant = await this.subMerchantRepo.findOne({
      where: { id: subMerchantId },
      relations: ['category'],
    });

    if (!subMerchant) {
      throw new HttpException('Sub-merchant not found', HttpStatus.NOT_FOUND);
    }

    const documents = await this.getKycDocuments(subMerchantId);
    const requiredDocs = await this.getRequiredDocuments(subMerchant.category?.code);
    
    const uploadedCodes = documents.map(d => d.documentType?.code);
    const missingDocuments = requiredDocs
      .filter(r => !uploadedCodes.includes(r.code))
      .map(d => d.code);

    return {
      status: subMerchant.kycStatus,
      submittedAt: subMerchant.kycSubmittedAt,
      approvedAt: subMerchant.kycApprovedAt,
      rejectionReason: subMerchant.kycRejectionReason,
      documents: documents.map(d => ({
        type: d.documentType?.code,
        status: d.status,
        uploadedAt: d.uploadedAt,
      })),
      missingDocuments,
    };
  }

  /**
   * Regenerate API key
   */
  async regenerateApiKey(subMerchantId: string): Promise<{ apiKey: string }> {
    const subMerchant = await this.subMerchantRepo.findOne({
      where: { id: subMerchantId },
    });

    if (!subMerchant) {
      throw new HttpException('Sub-merchant not found', HttpStatus.NOT_FOUND);
    }

    const { apiKey, apiKeyHash, apiKeyPrefix } = this.generateApiCredentials();

    subMerchant.apiKeyHash = apiKeyHash;
    subMerchant.apiKeyPrefix = apiKeyPrefix;

    await this.subMerchantRepo.save(subMerchant);

    return { apiKey };
  }

  // ============================================================================
  // Helper Methods
  // ============================================================================

  private async generateMerchantCode(categoryCode: string): Promise<string> {
    const prefix = categoryCode.substring(0, 2).toUpperCase();
    
    // Get next sequence
    const count = await this.subMerchantRepo.count();
    const sequence = (count + 1).toString().padStart(5, '0');
    
    return `SM-${prefix}-${sequence}`;
  }

  private generateApiCredentials(): {
    apiKey: string;
    apiKeyHash: string;
    apiKeyPrefix: string;
    publishableKey: string;
  } {
    const apiKey = `sk_live_${nanoid(32)}`;
    const publishableKey = `pk_live_${nanoid(24)}`;
    const apiKeyHash = bcrypt.hashSync(apiKey, 10);
    const apiKeyPrefix = apiKey.substring(0, 14);

    return { apiKey, apiKeyHash, apiKeyPrefix, publishableKey };
  }

  private async getRequiredDocuments(categoryCode?: string): Promise<KycDocumentType[]> {
    const allDocs = await this.kycDocTypeRepo.find({
      where: { isRequired: true },
    });

    return allDocs.filter(doc => {
      if (!doc.appliesToCategories || doc.appliesToCategories.length === 0) {
        return true; // Applies to all
      }
      return doc.appliesToCategories.includes(categoryCode);
    });
  }

  private async checkKycCompleteness(subMerchantId: string): Promise<void> {
    const subMerchant = await this.subMerchantRepo.findOne({
      where: { id: subMerchantId },
      relations: ['category'],
    });

    if (!subMerchant) return;

    const requiredDocs = await this.getRequiredDocuments(subMerchant.category?.code);
    const uploadedDocs = await this.kycDocumentRepo.find({
      where: { subMerchantId },
      relations: ['documentType'],
    });

    const uploadedCodes = uploadedDocs.map(d => d.documentType?.code);
    const allUploaded = requiredDocs.every(r => uploadedCodes.includes(r.code));

    if (allUploaded) {
      // Notify merchant that KYC is ready for submission
      await this.notificationService.sendKycReadyForSubmission(subMerchant);
    }
  }
}

// Import statement for In operator (should be at top)
import { In } from 'typeorm';

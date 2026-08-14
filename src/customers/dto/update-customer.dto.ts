import { PartialType, OmitType } from '@nestjs/mapped-types';
import { CreateCustomerDto } from './create-customer.dto';

// Everything from CreateCustomerDto is updatable, all optional.
// sourceChannel is excluded — it reflects how the profile originated
// and should never be rewritten after the fact (see business rules).
export class UpdateCustomerDto extends PartialType(OmitType(CreateCustomerDto, ['sourceChannel'] as const)) {}

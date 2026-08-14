import { Module } from '@nestjs/common';
import { TagsController } from './tags.controller';
import { CustomFieldsController } from './custom-fields.controller';

@Module({
  controllers: [TagsController, CustomFieldsController],
})
export class OrgResourcesModule {}

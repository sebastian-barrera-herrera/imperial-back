import { Module } from '@nestjs/common';
import { StaffDirectoryController, UsersController } from './users.controller';

@Module({ controllers: [UsersController, StaffDirectoryController] })
export class UsersModule {}

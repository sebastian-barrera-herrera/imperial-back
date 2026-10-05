import { Body, Controller, Get, Put } from '@nestjs/common';
import { CurrentUser } from '../common/decorators';
import { AuthUser } from '../common/types';
import { UpdateProfileDto } from './dto';
import { ProfileService } from './profile.service';

@Controller('profile')
export class ProfileController {
  constructor(private readonly profile: ProfileService) {}

  @Get()
  get(@CurrentUser() user: AuthUser) {
    return this.profile.get(user.id);
  }

  @Put()
  update(@CurrentUser() user: AuthUser, @Body() dto: UpdateProfileDto) {
    return this.profile.update(user, dto);
  }
}

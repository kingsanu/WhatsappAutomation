import { IsString, IsOptional, IsNotEmpty } from 'class-validator';

export class SendMessageDto {
  @IsString()
  @IsNotEmpty()
  number: string;

  @IsString()
  @IsOptional()
  message?: string;

  @IsString()
  @IsOptional()
  document?: string;
}

import {
  IsString,
  IsOptional,
  IsNotEmpty,
  IsUrl,
  Matches,
  ValidateIf,
} from "class-validator";
import { Transform } from "class-transformer";

export class SendMessageDto {
  @IsString()
  @IsNotEmpty()
  @Matches(/^\+?[1-9]\d{1,14}$/, {
    message: "Phone number must be a valid international format (E.164)",
  })
  @Transform(({ value }) => value?.replace(/\s+/g, "")) // Remove spaces
  number!: string; // Using definite assignment assertion since this will be validated

  @IsString()
  @IsOptional()
  @ValidateIf((o) => !o.document) // Message required if no document
  @IsNotEmpty({
    message: "Message cannot be empty when no document is provided",
  })
  message?: string;

  @IsString()
  @IsOptional()
  @IsUrl({}, { message: "Document must be a valid URL" })
  @ValidateIf((o) => !o.message) // Document required if no message
  @IsNotEmpty({
    message: "Document cannot be empty when no message is provided",
  })
  document?: string;
}

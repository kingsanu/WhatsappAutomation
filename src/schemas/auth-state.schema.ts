import { Prop, Schema, SchemaFactory } from '@nestjs/mongoose';
import { Document } from 'mongoose';

export type AuthStateDocument = AuthState & Document;

@Schema({ timestamps: true })
export class AuthState {
  @Prop({ required: true, unique: true })
  userId: string;

  @Prop({ type: Object, required: true })
  credentials: any;

  @Prop({ type: Object, default: {} })
  keys: any;

  @Prop({ default: 'disconnected' })
  connectionStatus: string;

  @Prop({ type: Object, default: null })
  user: any;

  @Prop({ type: Date, default: Date.now })
  lastUpdated: Date;
}

export const AuthStateSchema = SchemaFactory.createForClass(AuthState);
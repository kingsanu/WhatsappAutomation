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

  // Enhanced session persistence fields
  @Prop({ type: Date, default: null })
  lastConnected: Date;

  @Prop({ type: Date, default: null })
  lastDisconnected: Date;

  @Prop({ type: String, default: null })
  lastDisconnectReason: string;

  @Prop({ type: Number, default: 0 })
  reconnectionAttempts: number;

  @Prop({ type: Boolean, default: true })
  autoReconnect: boolean;

  @Prop({ type: Object, default: null })
  sessionMetadata: any;

  @Prop({ type: String, default: null })
  phoneNumber: string;

  @Prop({ type: String, default: null })
  deviceName: string;

  @Prop({ type: Boolean, default: false })
  isPersistent: boolean;
}

export const AuthStateSchema = SchemaFactory.createForClass(AuthState);
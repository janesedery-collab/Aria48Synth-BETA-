import { relations } from 'drizzle-orm';
import { integer, pgTable, serial, text, timestamp, jsonb } from 'drizzle-orm/pg-core';

// Registered users table linked to Firebase Auth UID
export const users = pgTable('users', {
  id: serial('id').primaryKey(),
  uid: text('uid').notNull().unique(), // Firebase Auth UID
  email: text('email').notNull(),
  displayName: text('display_name'),
  photoUrl: text('photo_url'),
  createdAt: timestamp('created_at').defaultNow(),
});

// Saved tracker songs & chiptune sequences
export const trackerSongs = pgTable('tracker_songs', {
  id: serial('id').primaryKey(),
  userId: text('user_id')
    .references(() => users.uid)
    .notNull(),
  title: text('title').notNull(),
  chipType: text('chip_type').notNull(),
  bpm: integer('bpm').default(125).notNull(),
  duration: text('duration').default('1:00').notNull(),
  channelsCount: integer('channels_count').default(16).notNull(),
  patternsData: jsonb('patterns_data').notNull(), // Matrix rows & channel data
  soundFontPreset: text('soundfont_preset'),
  createdAt: timestamp('created_at').defaultNow(),
  updatedAt: timestamp('updated_at').defaultNow(),
});

// Saved user custom SoundFonts metadata
export const customSoundFonts = pgTable('custom_soundfonts', {
  id: serial('id').primaryKey(),
  userId: text('user_id')
    .references(() => users.uid)
    .notNull(),
  name: text('name').notNull(),
  presetId: text('preset_id').notNull(),
  version: text('version').default('2.04'),
  instrumentCount: integer('instrument_count').default(1),
  createdAt: timestamp('created_at').defaultNow(),
});

export const usersRelations = relations(users, ({ many }) => ({
  songs: many(trackerSongs),
  soundFonts: many(customSoundFonts),
}));

export const trackerSongsRelations = relations(trackerSongs, ({ one }) => ({
  author: one(users, {
    fields: [trackerSongs.userId],
    references: [users.uid],
  }),
}));

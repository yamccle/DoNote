import { sqliteTable, text } from 'drizzle-orm/sqlite-core';
export const notes = sqliteTable('notes', {id:text('id').primaryKey(),owner:text('owner').notNull(),payload:text('payload').notNull(),updatedAt:text('updated_at').notNull()});

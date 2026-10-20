import { requireCloudOwnerId } from './cloudWorkspace.js'
import { normalizeDocumentCategory } from './localDocuments.js'

function throwIfSupabaseError(error) {
  if (error) throw error
}

// Conversation mentions still consume the cloud summary list until Task 5.
// The document workspace itself must use localDocuments.js for all persistence.
export async function listCloudDocuments(client, ownerId, category) {
  requireCloudOwnerId(ownerId)
  const query = client
    .from('cloud_documents')
    .select('*')
    .eq('status', 'active')

  const documentCategory = normalizeDocumentCategory(category)
  if (category) query.eq('metadata->>category', documentCategory)

  const { data, error } = await query.order('updated_at', { ascending: false })
  throwIfSupabaseError(error)
  return Array.isArray(data) ? data : []
}

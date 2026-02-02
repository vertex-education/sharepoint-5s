/**
 * analyze Edge Function
 * Hybrid analysis: deterministic rules engine (~80%) + Groq Llama 3.3 70B (~20%).
 * Rules are free and run on every scan. Groq is optional (free tier: 14,400 req/day).
 */

import { serve } from 'https://deno.land/std@0.177.0/http/server.ts';
import { corsHeaders, handleCors } from '../_shared/cors.ts';
import { verifyAuth } from '../_shared/auth.ts';
import { getAdminClient } from '../_shared/supabase-admin.ts';
import { analyzeFiles, ANALYSIS_SYSTEM_PROMPT, isGroqAvailable } from '../_shared/groq.ts';

const BATCH_SIZE = 500;
const TWO_YEARS_MS = 2 * 365.25 * 24 * 60 * 60 * 1000;
const FOUR_YEARS_MS = 4 * 365.25 * 24 * 60 * 60 * 1000;

// ─── Naming Convention Patterns ───

const BACKUP_PATTERNS = [
  /[_\s-]backup$/i,
  /[_\s-]bak$/i,
  /[_\s-]old$/i,
  /^Copy of /i,
  /\(\d+\)(?:\.\w+)?$/,           // "file (1).docx", "report (2).pdf"
  /[_\s-]copy(?:\s?\d+)?$/i,      // "file_copy", "file_copy2"
];

const VERSION_SUFFIX_PATTERNS = [
  /[_\s-]v\d+/i,                  // "_v2", " v3"
  /[_\s-]ver\d+/i,                // "_ver2"
  /[_\s-]final/i,                 // "_final", "_FINAL"
  /[_\s-]final[_\s-]?v?\d*/i,     // "_final_v2", "_finalv3"
  /[_\s-]draft/i,                 // "_draft"
  /[_\s-]rev\d*/i,                // "_rev", "_rev2"
  /[_\s-]edited/i,                // "_edited"
  /[_\s-]updated/i,               // "_updated"
  /[_\s-]new$/i,                  // "_new"
  /[_\s-]latest$/i,               // "_latest"
];

const SPECIAL_CHAR_PATTERN = /[#%&{}\\<>*?/$!'":@+`|=]/;
const ALL_CAPS_PATTERN = /^[A-Z0-9_\s-]{8,}\.\w+$/;  // 8+ char all-caps filenames

serve(async (req: Request) => {
  const corsResponse = handleCors(req);
  if (corsResponse) return corsResponse;

  try {
    const { userId } = await verifyAuth(req);
    const { scan_id } = await req.json();

    if (!scan_id) {
      return new Response(
        JSON.stringify({ error: 'scan_id is required' }),
        { status: 400, headers: { ...corsHeaders(req), 'Content-Type': 'application/json' } }
      );
    }

    const admin = getAdminClient();

    // Verify scan belongs to user and is crawled
    const { data: scan, error: scanErr } = await admin
      .from('scans')
      .select('*')
      .eq('id', scan_id)
      .eq('user_id', userId)
      .single();

    if (scanErr || !scan) {
      return new Response(
        JSON.stringify({ error: 'Scan not found' }),
        { status: 404, headers: { ...corsHeaders(req), 'Content-Type': 'application/json' } }
      );
    }

    if (scan.status !== 'crawled') {
      return new Response(
        JSON.stringify({ error: `Scan is not ready for analysis. Current status: ${scan.status}` }),
        { status: 400, headers: { ...corsHeaders(req), 'Content-Type': 'application/json' } }
      );
    }

    // Set status to analyzing
    await admin.from('scans').update({ status: 'analyzing', updated_at: new Date().toISOString() }).eq('id', scan_id);

    // Fetch all crawled files
    const { data: files, error: filesErr } = await admin
      .from('crawled_files')
      .select('*')
      .eq('scan_id', scan_id);

    if (filesErr) throw filesErr;

    const now = Date.now();
    const suggestions: any[] = [];
    const rulesMatchedFileIds = new Set<string>();  // Track files caught by rules

    // ─── Phase 1: Deterministic Rules Engine ───

    // === Rule 1: Zero-byte files ===
    for (const file of files) {
      if (file.is_folder) continue;

      if (file.size_bytes === 0) {
        suggestions.push({
          scan_id,
          file_id: file.id,
          category: 'delete',
          severity: 'high',
          title: 'Empty file',
          description: `This file is 0 bytes. It may be a failed upload or an accidentally created empty file.`,
          current_value: file.path,
          suggested_value: null,
          confidence: 0.95,
        });
        rulesMatchedFileIds.add(file.id);
      }
    }

    // === Rule 2: Temp / system files ===
    const tempPatterns = [/^~\$/, /\.tmp$/i, /^Thumbs\.db$/i, /^\.DS_Store$/i, /^desktop\.ini$/i, /^\.gitkeep$/i, /^~lock\./];
    for (const file of files) {
      if (file.is_folder) continue;
      if (tempPatterns.some(p => p.test(file.name))) {
        suggestions.push({
          scan_id,
          file_id: file.id,
          category: 'delete',
          severity: 'critical',
          title: 'Temporary file',
          description: `System/temporary file that should not be in a document library.`,
          current_value: file.path,
          suggested_value: null,
          confidence: 1.0,
        });
        rulesMatchedFileIds.add(file.id);
      }
    }

    // === Rule 3: Backup / copy pattern files ===
    for (const file of files) {
      if (file.is_folder) continue;
      const nameWithoutExt = file.name.replace(/\.\w+$/, '');
      if (BACKUP_PATTERNS.some(p => p.test(nameWithoutExt) || p.test(file.name))) {
        suggestions.push({
          scan_id,
          file_id: file.id,
          category: 'delete',
          severity: 'high',
          title: 'Backup/copy file',
          description: `Filename "${file.name}" matches a backup or copy pattern. If the original exists, this duplicate can likely be removed.`,
          current_value: file.path,
          suggested_value: null,
          confidence: 0.8,
        });
        rulesMatchedFileIds.add(file.id);
      }
    }

    // === Rule 4: Version suffix in filename ===
    for (const file of files) {
      if (file.is_folder) continue;
      const nameWithoutExt = file.name.replace(/\.\w+$/, '');
      if (VERSION_SUFFIX_PATTERNS.some(p => p.test(nameWithoutExt))) {
        // Suggest a clean name
        let cleanName = nameWithoutExt;
        for (const p of VERSION_SUFFIX_PATTERNS) {
          cleanName = cleanName.replace(p, '');
        }
        cleanName = cleanName.replace(/[_\s-]+$/, '');  // trim trailing separators
        const ext = file.file_extension ? `.${file.file_extension}` : '';
        suggestions.push({
          scan_id,
          file_id: file.id,
          category: 'rename',
          severity: 'medium',
          title: 'Version suffix in filename',
          description: `"${file.name}" has version indicators in the name. Use SharePoint's built-in versioning instead.`,
          current_value: file.path,
          suggested_value: `${cleanName}${ext}`,
          confidence: 0.75,
        });
        rulesMatchedFileIds.add(file.id);
      }
    }

    // === Rule 5: ALL CAPS filenames ===
    for (const file of files) {
      if (file.is_folder) continue;
      if (ALL_CAPS_PATTERN.test(file.name)) {
        const ext = file.file_extension ? `.${file.file_extension}` : '';
        const nameWithoutExt = file.name.replace(/\.\w+$/, '');
        const suggested = nameWithoutExt.toLowerCase().replace(/\s+/g, '-') + ext;
        suggestions.push({
          scan_id,
          file_id: file.id,
          category: 'rename',
          severity: 'low',
          title: 'ALL CAPS filename',
          description: `"${file.name}" is in ALL CAPS. Consider using standard casing for consistency.`,
          current_value: file.path,
          suggested_value: suggested,
          confidence: 0.7,
        });
        rulesMatchedFileIds.add(file.id);
      }
    }

    // === Rule 6: Special characters in filename ===
    for (const file of files) {
      if (file.is_folder) continue;
      if (SPECIAL_CHAR_PATTERN.test(file.name)) {
        const cleanName = file.name.replace(/[#%&{}\\<>*?/$!'":@+`|=]/g, '').replace(/\s{2,}/g, ' ').trim();
        suggestions.push({
          scan_id,
          file_id: file.id,
          category: 'rename',
          severity: 'medium',
          title: 'Special characters in filename',
          description: `"${file.name}" contains special characters that can cause issues with syncing, URLs, or cross-platform access.`,
          current_value: file.path,
          suggested_value: cleanName,
          confidence: 0.85,
        });
        rulesMatchedFileIds.add(file.id);
      }
    }

    // === Rule 7: Very old files (>4 years) ===
    for (const file of files) {
      if (file.is_folder) continue;
      if (file.modified_at_sp) {
        const age = now - new Date(file.modified_at_sp).getTime();
        if (age > FOUR_YEARS_MS) {
          suggestions.push({
            scan_id,
            file_id: file.id,
            category: 'delete',
            severity: 'medium',
            title: 'Very old file',
            description: `Not modified since ${new Date(file.modified_at_sp).toLocaleDateString()}. Consider whether this is still needed.`,
            current_value: file.path,
            suggested_value: null,
            confidence: 0.6,
          });
          rulesMatchedFileIds.add(file.id);
        } else if (age > TWO_YEARS_MS) {
          suggestions.push({
            scan_id,
            file_id: file.id,
            category: 'archive',
            severity: 'medium',
            title: 'Stale file',
            description: `Not modified since ${new Date(file.modified_at_sp).toLocaleDateString()}. Consider archiving to cold storage.`,
            current_value: file.path,
            suggested_value: null,
            confidence: 0.65,
          });
          rulesMatchedFileIds.add(file.id);
        }
      }
    }

    // === Rule 8: Duplicate detection (same name + same size) ===
    const filesByNameSize = new Map<string, any[]>();
    for (const file of files) {
      if (file.is_folder) continue;
      const key = `${file.name.toLowerCase()}::${file.size_bytes}`;
      if (!filesByNameSize.has(key)) filesByNameSize.set(key, []);
      filesByNameSize.get(key)!.push(file);
    }

    for (const [, dupes] of filesByNameSize) {
      if (dupes.length < 2) continue;
      dupes.sort((a: any, b: any) =>
        new Date(b.modified_at_sp || 0).getTime() - new Date(a.modified_at_sp || 0).getTime()
      );

      for (let i = 1; i < dupes.length; i++) {
        suggestions.push({
          scan_id,
          file_id: dupes[i].id,
          category: 'delete',
          severity: 'high',
          title: 'Duplicate file',
          description: `This file appears to be a duplicate of "${dupes[0].path}" (same name and size). The copy at "${dupes[0].path}" was more recently modified.`,
          current_value: dupes[i].path,
          suggested_value: null,
          confidence: 0.85,
        });
        rulesMatchedFileIds.add(dupes[i].id);
      }
    }

    // === Rule 9: Zip files with unzipped contents nearby ===
    const zipFiles = files.filter((f: any) => !f.is_folder && /\.(zip|rar|7z|tar\.gz|tgz)$/i.test(f.name));
    for (const zip of zipFiles) {
      const zipDir = zip.path.substring(0, zip.path.lastIndexOf('/'));
      const zipBaseName = zip.name.replace(/\.(zip|rar|7z|tar\.gz|tgz)$/i, '');
      // Check if a folder with the same base name exists in the same directory
      const matchingFolder = files.find((f: any) =>
        f.is_folder &&
        f.name.toLowerCase() === zipBaseName.toLowerCase() &&
        f.path.startsWith(zipDir)
      );
      if (matchingFolder) {
        suggestions.push({
          scan_id,
          file_id: zip.id,
          category: 'delete',
          severity: 'medium',
          title: 'Archive with extracted contents',
          description: `"${zip.name}" appears to have been extracted into folder "${matchingFolder.name}" nearby. The archive is likely no longer needed.`,
          current_value: zip.path,
          suggested_value: null,
          confidence: 0.75,
        });
        rulesMatchedFileIds.add(zip.id);
      }
    }

    // === Rule 10: Deep folder detection (depth > 4) ===
    for (const file of files) {
      if (!file.is_folder) continue;
      if (file.depth > 4) {
        suggestions.push({
          scan_id,
          file_id: file.id,
          category: 'structure',
          severity: 'high',
          title: 'Deeply nested folder',
          description: `This folder is ${file.depth} levels deep. Consider flattening the folder structure for easier navigation.`,
          current_value: file.path,
          suggested_value: null,
          confidence: 0.8,
        });
        rulesMatchedFileIds.add(file.id);
      }
    }

    // === Rule 11: Sparse folders (1-2 files) ===
    const folderChildCounts = new Map<string, number>();
    for (const file of files) {
      if (file.is_folder) continue;
      const parentPath = file.path.substring(0, file.path.lastIndexOf('/'));
      folderChildCounts.set(parentPath, (folderChildCounts.get(parentPath) || 0) + 1);
    }

    for (const folder of files) {
      if (!folder.is_folder) continue;
      const childCount = folderChildCounts.get(folder.path) || 0;
      if (childCount > 0 && childCount <= 2 && folder.depth > 1) {
        suggestions.push({
          scan_id,
          file_id: folder.id,
          category: 'structure',
          severity: 'medium',
          title: 'Sparse folder',
          description: `This folder contains only ${childCount} file${childCount === 1 ? '' : 's'}. Consider merging its contents into the parent folder to simplify navigation.`,
          current_value: folder.path,
          suggested_value: null,
          confidence: 0.7,
        });
        rulesMatchedFileIds.add(folder.id);
      }
    }

    // === Rule 12: Overcrowded folders (50+ children) ===
    const folderDirectChildren = new Map<string, number>();
    for (const file of files) {
      const parentPath = file.path.substring(0, file.path.lastIndexOf('/'));
      folderDirectChildren.set(parentPath, (folderDirectChildren.get(parentPath) || 0) + 1);
    }

    for (const folder of files) {
      if (!folder.is_folder) continue;
      const directCount = folderDirectChildren.get(folder.path) || 0;
      if (directCount >= 50) {
        suggestions.push({
          scan_id,
          file_id: folder.id,
          category: 'structure',
          severity: 'medium',
          title: 'Overcrowded folder',
          description: `This folder has ${directCount} direct children. Consider organizing into subfolders by type, date, or project to improve discoverability.`,
          current_value: folder.path,
          suggested_value: null,
          confidence: 0.75,
        });
        rulesMatchedFileIds.add(folder.id);
      }
    }

    // ─── Phase 2: Groq AI Analysis (only for uncaught files) ───

    if (isGroqAvailable()) {
      // Filter to only files NOT already matched by rules
      const uncaughtFiles = files.filter((f: any) => !rulesMatchedFileIds.has(f.id));

      if (uncaughtFiles.length > 0) {
        // Group by top-level folder for chunked analysis
        const filesByTopFolder = new Map<string, any[]>();
        for (const file of uncaughtFiles) {
          const topFolder = file.path.split('/').filter(Boolean)[0] || 'root';
          if (!filesByTopFolder.has(topFolder)) filesByTopFolder.set(topFolder, []);
          filesByTopFolder.get(topFolder)!.push(file);
        }

        // Build chunks
        const chunks: any[][] = [];
        let currentChunk: any[] = [];

        for (const [, folderFiles] of filesByTopFolder) {
          if (currentChunk.length + folderFiles.length > BATCH_SIZE && currentChunk.length > 0) {
            chunks.push(currentChunk);
            currentChunk = [];
          }
          currentChunk.push(...folderFiles.map((f: any) => ({
            path: f.path,
            name: f.name,
            extension: f.file_extension,
            size: f.size_bytes,
            is_folder: f.is_folder,
            depth: f.depth,
            created: f.created_at_sp,
            modified: f.modified_at_sp,
            created_by: f.created_by,
            modified_by: f.modified_by,
          })));
        }

        if (currentChunk.length > 0) chunks.push(currentChunk);

        // Run Groq on each chunk
        for (const chunk of chunks) {
          try {
            const aiSuggestions = await analyzeFiles(
              {
                total_files: files.filter((f: any) => !f.is_folder).length,
                total_folders: files.filter((f: any) => f.is_folder).length,
                uncaught_count: uncaughtFiles.length,
                rules_matched_count: rulesMatchedFileIds.size,
                files: chunk,
              },
              ANALYSIS_SYSTEM_PROMPT
            );

            for (const s of aiSuggestions) {
              const matchedFile = files.find((f: any) => f.path === s.file_path);
              suggestions.push({
                scan_id,
                file_id: matchedFile?.id || null,
                category: s.category,
                severity: s.severity,
                title: s.title,
                description: s.description,
                current_value: s.file_path,
                suggested_value: s.suggested_value,
                confidence: s.confidence,
              });
            }
          } catch (aiErr) {
            console.error('Groq analysis error for chunk:', aiErr);
            // Continue — rules-only results are still valuable
          }
        }
      }
    } else {
      console.log('GROQ_API_KEY not set — running rules-only analysis');
    }

    // ─── Phase 3: Deduplicate and Store ───

    const seen = new Set<string>();
    const uniqueSuggestions = suggestions.filter(s => {
      const key = `${s.file_id || s.current_value}::${s.category}::${s.title}`;
      if (seen.has(key)) return false;
      seen.add(key);
      return true;
    });

    // Batch insert suggestions
    if (uniqueSuggestions.length > 0) {
      const batchSize = 500;
      for (let i = 0; i < uniqueSuggestions.length; i += batchSize) {
        const batch = uniqueSuggestions.slice(i, i + batchSize);
        const { error: insertErr } = await admin.from('suggestions').insert(batch);
        if (insertErr) console.error('Suggestion insert error:', insertErr);
      }
    }

    // Update scan status
    await admin.from('scans').update({
      status: 'complete',
      updated_at: new Date().toISOString(),
    }).eq('id', scan_id);

    // Category counts
    const categories = { delete: 0, archive: 0, rename: 0, structure: 0 };
    uniqueSuggestions.forEach(s => { categories[s.category as keyof typeof categories]++; });

    return new Response(
      JSON.stringify({
        suggestion_count: uniqueSuggestions.length,
        categories,
        rules_matched: rulesMatchedFileIds.size,
        ai_analyzed: isGroqAvailable() ? files.length - rulesMatchedFileIds.size : 0,
        ai_available: isGroqAvailable(),
      }),
      { status: 200, headers: { ...corsHeaders(req), 'Content-Type': 'application/json' } }
    );

  } catch (err) {
    console.error('analyze error:', err);

    try {
      const admin = getAdminClient();
      const { scan_id } = await req.json().catch(() => ({}));
      if (scan_id) {
        await admin.from('scans').update({
          status: 'error',
          error_message: err.message,
        }).eq('id', scan_id);
      }
    } catch {}

    return new Response(
      JSON.stringify({ error: err.message }),
      { status: 500, headers: { ...corsHeaders(req), 'Content-Type': 'application/json' } }
    );
  }
});

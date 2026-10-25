import { anthropic } from '@ai-sdk/anthropic'
import { Agent } from '@mastra/core/agent'
import { createTool } from '@mastra/core/tools'
import { Octokit } from 'octokit'
import { z } from 'zod'

const octokit = new Octokit({
  auth: process.env.GITHUB_TOKEN,
})

// Helper function to parse diff text
function parseDiff(diffText: string) {
  console.log(`[GitHub] Parsing diff text of length ${diffText.length}`)
  const files = []
  const fileHeaders = diffText.split('diff --git ')
  console.log(`[GitHub] Found ${fileHeaders.length - 1} file headers in diff`)

  // Skip the first empty element
  for (let i = 1; i < fileHeaders.length; i++) {
    const fileHeader = fileHeaders[i]
    const fileNameMatch = fileHeader.match(/a\/(.*?) b\//)

    if (fileNameMatch?.[1]) {
      const path = fileNameMatch[1]
      console.log(`[GitHub] Processing diff for a file: ${path}`)
      const diffLines = fileHeader.split('\n')
      console.log(`[GitHub] Diff for ${path} has ${diffLines.length} lines`)

      // Find hunk headers to properly track positions
      const hunkHeaders = []
      let additions = 0
      let deletions = 0
      let inHunk = false
      let hunkStartLine = 0
      let isNewFile = false
      let isDeleted = false

      // Check if file is new or deleted
      for (let j = 0; j < Math.min(10, diffLines.length); j++) {
        if (diffLines[j].includes('new file mode')) {
          isNewFile = true
          console.log(`[GitHub] ${path} is a new file`)
          break
        }
        if (diffLines[j].includes('deleted file mode')) {
          isDeleted = true
          console.log(`[GitHub] ${path} is a deleted file`)
          break
        }
      }

      // Process each line to count additions/deletions and track positions
      for (let j = 0; j < diffLines.length; j++) {
        const line = diffLines[j]

        // Track hunk headers
        if (line.startsWith('@@')) {
          inHunk = true
          hunkHeaders.push({
            index: j,
            content: line,
          })

          // Extract the starting line number from the hunk header
          // Format: @@ -old_start,old_count +new_start,new_count @@
          const match = line.match(/\+(\d+)/)
          if (match?.[1]) {
            hunkStartLine = Number.parseInt(match[1], 10)
            console.log(`[GitHub] Found hunk header at line ${j}: ${line}, starting at line ${hunkStartLine}`)
          } else {
            console.log(`[GitHub] Found hunk header at line ${j} but couldn't parse line number: ${line}`)
          }
          continue
        }

        if (inHunk) {
          // Count additions and deletions
          if (line.startsWith('+') && !line.startsWith('+++')) {
            additions++
          } else if (line.startsWith('-') && !line.startsWith('---')) {
            deletions++
          } else if (!line.startsWith('\\') && !line.startsWith('---') && !line.startsWith('+++')) {
            // Context line (unchanged)
          }
        }
      }

      console.log(
        `[GitHub] File ${path} has ${additions} additions, ${deletions} deletions, ${hunkHeaders.length} hunks`,
      )
      files.push({
        path,
        diff: fileHeader,
        additions,
        deletions,
        changes: additions + deletions,
        hunkHeaders,
        isNewFile,
        isDeleted,
        isEmpty: additions === 0 && deletions === 0,
        onlyDeletions: additions === 0 && deletions > 0,
      })
    } else {
      console.log(`[GitHub] Could not extract file path from header: ${fileHeader.substring(0, 100)}...`)
    }
  }

  return files
}

// Helper function to find line positions in diff
export function findPositionInDiff(diffText: string, filePath: string, lineNumber: number): number | undefined {
  console.log(`[GitHub] Finding position in diff for ${filePath}:${lineNumber}`)
  console.log(`[GitHub] Diff text length: ${diffText.length} bytes`)

  // Log a sample of the diff for debugging
  console.log(`[GitHub] Diff sample (first 500 chars): ${diffText.substring(0, 500)}...`)

  const files = parseDiff(diffText)
  console.log(`[GitHub] Parsed ${files.length} files from diff`)

  const fileDiff = files.find((file) => file.path === filePath)
  if (!fileDiff) {
    console.log(`[GitHub] File ${filePath} not found in diff`)
    // Log all available file paths for debugging
    console.log(`[GitHub] Available files in diff: ${files.map((f) => f.path).join(', ')}`)
    return undefined
  }

  console.log(
    `[GitHub] Found file ${filePath} in diff with ${fileDiff.additions} additions, ${fileDiff.deletions} deletions`,
  )

  // Handle edge cases
  if (fileDiff.isEmpty) {
    console.log(`[GitHub] File ${filePath} has no changes in the diff`)
    return undefined
  }

  if (fileDiff.isDeleted) {
    console.log(`[GitHub] File ${filePath} is deleted in this PR, cannot comment on line ${lineNumber}`)
    return undefined
  }

  if (fileDiff.onlyDeletions) {
    console.log(`[GitHub] File ${filePath} only has deletions, cannot comment on line ${lineNumber} in the new version`)
    return undefined
  }

  if (fileDiff.isNewFile && lineNumber > fileDiff.additions) {
    console.log(`[GitHub] Line ${lineNumber} is beyond the end of new file ${filePath} (${fileDiff.additions} lines)`)
    return undefined
  }

  const lines = fileDiff.diff.split('\n')
  console.log(`[GitHub] Diff for ${filePath} has ${lines.length} lines`)

  // Log the first few lines of the file diff for debugging
  console.log(`[GitHub] First 10 lines of diff for ${filePath}:`)
  for (let i = 0; i < Math.min(10, lines.length); i++) {
    console.log(`  Line ${i}: ${lines[i].substring(0, 100)}${lines[i].length > 100 ? '...' : ''}`)
  }

  let position = 0
  let inHunk = false
  const debugLines: string[] = []
  let lastHunkHeader = ''
  let maxLineInFile = 0

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i]

    // Track hunk headers to reset position counting
    if (line.startsWith('@@')) {
      inHunk = true
      position = i
      lastHunkHeader = line

      // Extract the starting line number from the hunk header
      // Format: @@ -old_start,old_count +new_start,new_count @@
      const match = line.match(/\+(\d+),(\d+)/)
      if (match?.[1] && match?.[2]) {
        const startLine = Number.parseInt(match[1], 10)
        const lineCount = Number.parseInt(match[2], 10)
        maxLineInFile = Math.max(maxLineInFile, startLine + lineCount - 1)
        console.log(
          `[GitHub] Found hunk header at position ${i}: ${line}, resetting to line ${startLine}, hunk covers up to line ${startLine + lineCount - 1}`,
        )
      } else {
        console.log(`[GitHub] Found hunk header at position ${i} but couldn't parse line number: ${line}`)
      }
      continue
    }

    // Skip diff header lines
    if (
      line.startsWith('diff --git') ||
      line.startsWith('index ') ||
      line.startsWith('---') ||
      line.startsWith('+++') ||
      !inHunk
    ) {
      continue
    }

    // Count lines in the new file
    if (line.startsWith('+') || (!line.startsWith('-') && !line.startsWith('\\'))) {
      position++
      maxLineInFile = Math.max(maxLineInFile, position)

      // Store some context for debugging
      if (Math.abs(position - lineNumber) <= 5) {
        debugLines.push(`Line ${position}: ${line.substring(0, 100)}${line.length > 100 ? '...' : ''}`)
      }

      if (position === lineNumber) {
        console.log(`[GitHub] Found position ${position} for line ${lineNumber} in ${filePath}`)
        console.log(`[GitHub] Last hunk header: ${lastHunkHeader}`)
        console.log(`[GitHub] Context around line ${lineNumber}:`)
        for (const l of debugLines) {
          console.log(`  ${l}`)
        }
        return position
      }
    } else if (line.startsWith('-')) {
      // Deletion lines count for position but not for current line
      position++
    }
  }

  console.log(`[GitHub] Could not find position for line ${lineNumber} in ${filePath}`)
  console.log(
    `[GitHub] Last line reached: ${position}, max line in file: ${maxLineInFile}, last hunk header: ${lastHunkHeader}`,
  )

  if (lineNumber > maxLineInFile) {
    console.log(`[GitHub] Line ${lineNumber} is beyond the end of file ${filePath} (${maxLineInFile} lines)`)
  }

  if (debugLines.length > 0) {
    console.log('[GitHub] Last context lines:')
    for (const l of debugLines) {
      console.log(`  ${l}`)
    }
  } else {
    console.log('[GitHub] No context lines found near target line')
  }

  // Log the last few lines of the file diff for debugging
  const lastLines = Math.min(5, lines.length)
  console.log(`[GitHub] Last ${lastLines} lines of diff for ${filePath}:`)
  for (let i = lines.length - lastLines; i < lines.length; i++) {
    if (i >= 0) {
      console.log(`  Line ${i}: ${lines[i].substring(0, 100)}${lines[i].length > 100 ? '...' : ''}`)
    }
  }

  return undefined
}

export const githubTools = {
  commentOnLineNumber: createTool({
    id: 'commentOnLineNumber',
    description: 'Comment on a specific line number in a file',
    inputSchema: z.object({
      file: z.string(),
      lineNumber: z.number(),
      comment: z.string(),
      owner: z.string(),
      repo: z.string(),
      pullNumber: z.number(),
      position: z.number().optional(),
    }),
    outputSchema: z.object({
      success: z.boolean(),
      message: z.string().optional(),
    }),
    execute: async ({ context: { file, lineNumber, comment, owner, repo, pullNumber: pull_number } }) => {
      console.log(`[GitHub] Getting PR ${owner}/${repo}#${pull_number}`)
      try {
        const { data: pr } = await octokit.rest.pulls.get({
          owner,
          repo,
          pull_number,
        })
        console.log(`[GitHub] Found PR ${owner}/${repo}#${pull_number}, head SHA: ${pr.head.sha}`)

        // We'll use line and side parameters instead of position
        console.log(`[GitHub] Creating review comment on ${file}:${lineNumber}`)
        console.log(
          `[GitHub] Comment content (first 100 chars): ${comment.substring(0, 100)}${comment.length > 100 ? '...' : ''}`,
        )

        const response = await octokit.rest.pulls.createReviewComment({
          owner,
          repo,
          pull_number,
          commit_id: pr.head.sha,
          path: file,
          line: lineNumber,
          side: 'RIGHT',
          body: comment,
        })

        console.log(`[GitHub] Successfully created comment with ID: ${response.data.id}`)
        console.log(`[GitHub] Comment URL: ${response.data.html_url}`)

        return {
          success: true,
          message: `Comment added to ${file}:${lineNumber}`,
        }
      } catch (error: unknown) {
        console.error('[GitHub] Error commenting on line:', error)
        if (error instanceof Error) {
          console.error(`[GitHub] Error details: ${error.message}`)
          if ('response' in error) {
            // @ts-expect-error
            console.error(`[GitHub] API response: ${JSON.stringify(error.response?.data)}`)
          }
        }
        return {
          success: false,
          message: error instanceof Error ? error.message : String(error),
        }
      }
    },
  }),

  batchCreateComments: createTool({
    id: 'batchCreateComments',
    description: 'Create multiple review comments in a single review',
    inputSchema: z.object({
      owner: z.string(),
      repo: z.string(),
      pullNumber: z.number(),
      comments: z.array(
        z.object({
          path: z.string(),
          line: z.number(),
          body: z.string(),
          side: z.enum(['RIGHT', 'LEFT']).optional(),
          position: z.number().optional(),
        }),
      ),
      reviewBody: z.string().optional(),
      event: z.enum(['APPROVE', 'REQUEST_CHANGES', 'COMMENT']).optional(),
    }),
    outputSchema: z.object({
      success: z.boolean(),
      message: z.string().optional(),
      commentCount: z.number().optional(),
      skippedComments: z
        .array(
          z.object({
            path: z.string(),
            line: z.number(),
            reason: z.string(),
          }),
        )
        .optional(),
    }),
    execute: async ({
      context: { owner, repo, pullNumber: pull_number, comments, reviewBody = '', event = 'COMMENT' },
    }) => {
      console.log(`[GitHub] Creating batch review with ${comments.length} comments for ${owner}/${repo}#${pull_number}`)
      console.log(`[GitHub] Review event: ${event}, body length: ${reviewBody.length} chars`)

      try {
        const { data: pr } = await octokit.rest.pulls.get({
          owner,
          repo,
          pull_number,
        })
        console.log(`[GitHub] Found PR ${owner}/${repo}#${pull_number}, head SHA: ${pr.head.sha}`)

        // Get the list of files in the PR to validate comment paths
        const { data: prFiles } = await octokit.rest.pulls.listFiles({
          owner,
          repo,
          pull_number,
        })

        // Create a map of file paths to their metadata for quick lookup
        const fileMap = new Map(
          prFiles.map((file) => [
            file.filename,
            {
              status: file.status,
              additions: file.additions,
              deletions: file.deletions,
              changes: file.changes,
            },
          ]),
        )

        console.log(`[GitHub] PR has ${prFiles.length} files`)

        // Validate comments against PR files
        const skippedComments = []
        const validComments = []

        for (const comment of comments) {
          const fileInfo = fileMap.get(comment.path)

          if (!fileInfo) {
            console.log(`[GitHub] Skipping comment on ${comment.path}:${comment.line} - file not in PR`)
            skippedComments.push({
              path: comment.path,
              line: comment.line,
              reason: 'File not found in PR',
            })
            continue
          }

          if (fileInfo.status === 'removed') {
            console.log(`[GitHub] Skipping comment on ${comment.path}:${comment.line} - file was deleted`)
            skippedComments.push({
              path: comment.path,
              line: comment.line,
              reason: 'File was deleted in PR',
            })
            continue
          }

          if (fileInfo.status === 'added' && comment.side === 'LEFT') {
            console.log(
              `[GitHub] Skipping comment on ${comment.path}:${comment.line} - cannot comment on LEFT side of new file`,
            )
            skippedComments.push({
              path: comment.path,
              line: comment.line,
              reason: 'Cannot comment on LEFT side of new file',
            })
            continue
          }

          if (fileInfo.additions === 0 && comment.side === 'RIGHT') {
            console.log(`[GitHub] Skipping comment on ${comment.path}:${comment.line} - file has no additions`)
            skippedComments.push({
              path: comment.path,
              line: comment.line,
              reason: 'File has no additions, cannot comment on RIGHT side',
            })
            continue
          }

          // Comment seems valid, add it to the list
          validComments.push({
            path: comment.path,
            line: comment.line,
            side: comment.side || 'RIGHT',
            body: comment.body,
          })
        }

        console.log(`[GitHub] Found ${validComments.length} valid comments, skipped ${skippedComments.length}`)

        if (validComments.length === 0) {
          console.log('[GitHub] No valid comments found, aborting review creation')
          return {
            success: false,
            message: 'Could not find valid positions for any comments',
            commentCount: 0,
            skippedComments,
          }
        }

        // Create a review with all comments
        console.log(`[GitHub] Creating review with ${validComments.length} comments`)
        const response = await octokit.rest.pulls.createReview({
          owner,
          repo,
          pull_number,
          commit_id: pr.head.sha,
          body: reviewBody,
          event,
          comments: validComments,
        })

        console.log(`[GitHub] Successfully created review with ID: ${response.data.id}`)
        console.log(`[GitHub] Submitting review for ${owner}/${repo}#${pull_number} with event ${event}`)

        return {
          success: true,
          message: `Created review with ${validComments.length} comments`,
          commentCount: validComments.length,
          skippedComments: skippedComments.length > 0 ? skippedComments : undefined,
        }
      } catch (error: unknown) {
        console.error('[GitHub] Error creating batch comments:', error)
        if (error instanceof Error) {
          console.error(`[GitHub] Error details: ${error.message}`)
          if ('response' in error) {
            // @ts-expect-error
            console.error(`[GitHub] API response: ${JSON.stringify(error.response?.data)}`)
          }
        }
        return {
          success: false,
          message: error instanceof Error ? error.message : String(error),
          commentCount: 0,
          skippedComments: [],
        }
      }
    },
  }),

  submitReview: createTool({
    id: 'submitReview',
    description: 'Submit a review for the entire PR',
    inputSchema: z.object({
      body: z.string(),
      event: z.enum(['APPROVE', 'REQUEST_CHANGES', 'COMMENT']),
      owner: z.string(),
      repo: z.string(),
      pullNumber: z.number(),
    }),
    outputSchema: z.object({
      success: z.boolean(),
      message: z.string().optional(),
    }),
    execute: async ({ context: { body, event, owner, repo, pullNumber: pull_number } }) => {
      console.log(`[GitHub] Submitting review for ${owner}/${repo}#${pull_number} with event ${event}`)
      try {
        await octokit.rest.pulls.createReview({
          owner,
          repo,
          pull_number,
          body,
          event,
        })

        return {
          success: true,
          message: `Review submitted with event: ${event}`,
        }
      } catch (error: unknown) {
        console.error('[GitHub] Error submitting review:', error)
        return {
          success: false,
          message: error instanceof Error ? error.message : String(error),
        }
      }
    },
  }),

  getDiff: createTool({
    id: 'getDiff',
    description: 'Get the diff for a specific file in the PR',
    inputSchema: z.object({
      owner: z.string(),
      repo: z.string(),
      pullNumber: z.number(),
      filePath: z.string(),
    }),
    outputSchema: z.object({
      path: z.string(),
      diff: z.string().optional(),
      additions: z.number().optional(),
      deletions: z.number().optional(),
      changes: z.number().optional(),
      error: z.string().optional(),
    }),
    execute: async ({ context: { owner, repo, pullNumber: pull_number, filePath } }) => {
      console.log(`[GitHub] Getting diff for file ${filePath} in ${owner}/${repo}#${pull_number}`)

      try {
        // Check if file exists in PR
        const { data: files } = await octokit.rest.pulls.listFiles({
          owner,
          repo,
          pull_number,
        })

        const fileExists = files.some((file) => file.filename === filePath)
        if (!fileExists) {
          console.log(`[GitHub] File ${filePath} not found in PR ${owner}/${repo}#${pull_number}`)
          return {
            path: filePath,
            error: 'File not found in PR',
          }
        }

        // Get diff for the file
        const { data } = await octokit.rest.pulls.get({
          owner,
          repo,
          pull_number,
          mediaType: {
            format: 'diff',
          },
        })

        // Parse the diff to extract just the requested file
        const diffText = data.toString()
        const fileDiffs = parseDiff(diffText)
        const fileDiff = fileDiffs.find((diff) => diff.path === filePath)

        if (!fileDiff) {
          console.log(`[GitHub] Diff for ${filePath} not found in PR ${owner}/${repo}#${pull_number}`)
          return {
            path: filePath,
            error: 'Diff not found for file',
          }
        }

        console.log(`[GitHub] Successfully retrieved diff for ${filePath}`)
        return {
          path: filePath,
          diff: fileDiff.diff,
          additions: fileDiff.additions,
          deletions: fileDiff.deletions,
          changes: fileDiff.changes,
        }
      } catch (error: unknown) {
        console.error(`[GitHub] Error getting diff for ${filePath}:`, error)
        return {
          path: filePath,
          error: error instanceof Error ? error.message : String(error),
        }
      }
    },
  }),

  getFiles: createTool({
    id: 'getFiles',
    description: 'Get list of files changed in the PR',
    inputSchema: z.object({
      owner: z.string(),
      repo: z.string(),
      pullNumber: z.number(),
      page: z.number().optional(),
      perPage: z.number().optional(),
      skipLockFiles: z.boolean().optional(),
      maxFileSize: z.number().optional(),
    }),
    outputSchema: z.object({
      files: z.array(
        z.object({
          filename: z.string(),
          changes: z.number(),
          additions: z.number(),
          deletions: z.number(),
          status: z.string(),
        }),
      ),
      page: z.number(),
      perPage: z.number(),
      hasMore: z.boolean(),
      skipped: z.array(z.string()),
      totalFiles: z.number(),
      filteredFiles: z.number(),
    }),
    execute: async ({
      context: {
        owner,
        repo,
        pullNumber: pull_number,
        page = 1,
        perPage = 30,
        skipLockFiles = true,
        maxFileSize = 100000,
      },
    }) => {
      console.log(`[GitHub] Getting changed files for ${owner}/${repo}#${pull_number} (page ${page})`)
      const { data } = await octokit.rest.pulls.listFiles({
        owner,
        repo,
        pull_number,
        per_page: perPage * 2, // Fetch more to account for filtered files
        page,
      })

      console.log(`[GitHub] Found ${data.length} files in PR ${owner}/${repo}#${pull_number}`)

      // Log file sizes to help diagnose issues
      for (const file of data) {
        console.log(
          `[GitHub] File: ${file.filename}, Size: ${file.changes} changes, ${file.additions} additions, ${file.deletions} deletions`,
        )
      }

      let filteredFiles = data
      if (skipLockFiles) {
        const lockFilePatterns = [
          /package-lock\.json$/,
          /yarn\.lock$/,
          /bun\.lockb$/,
          /bun\.lock$/,
          /Gemfile\.lock$/,
          /Cargo\.lock$/,
          /composer\.lock$/,
          /poetry\.lock$/,
          /\.lock$/,
          /\.sum$/,
          /\.snap$/,
          /\.min\.(js|css)$/,
          /\.d\.ts$/,
        ]

        const beforeCount = filteredFiles.length
        filteredFiles = filteredFiles.filter((file) => !lockFilePatterns.some((pattern) => pattern.test(file.filename)))
        console.log(`[GitHub] Filtered out ${beforeCount - filteredFiles.length} lock files`)
      }

      // Filter out large files
      const beforeSizeCount = filteredFiles.length
      filteredFiles = filteredFiles.filter((file) => file.changes <= maxFileSize)
      console.log(
        `[GitHub] Filtered out ${beforeSizeCount - filteredFiles.length} large files (>${maxFileSize} changes)`,
      )

      // Apply pagination after filtering
      const paginatedFiles = filteredFiles.slice(0, perPage)
      console.log(`[GitHub] Returning ${paginatedFiles.length} files after pagination`)

      const skippedFiles = data
        .filter((file) => !paginatedFiles.some((pf) => pf.filename === file.filename))
        .map((file) => `${file.filename} (${file.changes} changes)`)

      console.log(`[GitHub] Skipped ${skippedFiles.length} files`)
      if (skippedFiles.length > 0) {
        console.log(`[GitHub] Skipped files: ${skippedFiles.join(', ')}`)
      }

      // Return just the filenames and metadata
      return {
        files: paginatedFiles.map((file) => ({
          filename: file.filename,
          changes: file.changes,
          additions: file.additions,
          deletions: file.deletions,
          status: file.status,
        })),
        page,
        perPage,
        hasMore: data.length === perPage * 2 || paginatedFiles.length === perPage,
        skipped: skippedFiles,
        totalFiles: data.length,
        filteredFiles: filteredFiles.length,
      }
    },
  }),

  getFileContent: createTool({
    id: 'getFileContent',
    description: 'Get content of a specific file in the PR',
    inputSchema: z.object({
      owner: z.string(),
      repo: z.string(),
      pullNumber: z.number(),
      filePath: z.string(),
      ref: z.string().optional(),
    }),
    outputSchema: z.object({
      path: z.string(),
      content: z.string().optional(),
      size: z.number().optional(),
      error: z.string().optional(),
    }),
    execute: async ({ context: { owner, repo, pullNumber: pull_number, filePath, ref } }) => {
      console.log(`[GitHub] Getting content for file ${filePath} in ${owner}/${repo}#${pull_number}`)

      try {
        // First get the PR to determine the head ref if not provided
        if (!ref) {
          const { data: pr } = await octokit.rest.pulls.get({
            owner,
            repo,
            pull_number,
          })
          ref = pr.head.sha
        }

        // Get the file content
        const { data } = await octokit.rest.repos.getContent({
          owner,
          repo,
          path: filePath,
          ref,
        })

        if ('content' in data) {
          const content = Buffer.from(data.content, 'base64').toString('utf-8')
          const contentSize = content.length
          console.log(`[GitHub] File content size for ${filePath}: ${contentSize} characters`)

          return {
            path: filePath,
            content,
            size: contentSize,
          }
        }

        throw new Error(`${filePath} is not a file`)
      } catch (error: unknown) {
        console.error(`[GitHub] Error getting content for ${filePath}:`, error)
        return {
          path: filePath,
          error: error instanceof Error ? error.message : String(error),
        }
      }
    },
  }),

  getPullRequest: createTool({
    id: 'getPullRequest',
    description: 'Get PR details including title, body, and state',
    inputSchema: z.object({
      owner: z.string(),
      repo: z.string(),
      pullNumber: z.number(),
    }),
    outputSchema: z.object({
      id: z.number(),
      number: z.number(),
      state: z.string(),
      title: z.string(),
      body: z.string().nullable(),
      user: z.object({
        login: z.string(),
      }),
      created_at: z.string(),
      updated_at: z.string(),
      head: z.object({
        sha: z.string(),
        ref: z.string(),
      }),
      base: z.object({
        ref: z.string(),
      }),
    }),
    execute: async ({ context: { owner, repo, pullNumber: pull_number } }) => {
      console.log(`[GitHub] Getting PR details for repository ${owner}/${repo}#${pull_number}`)
      const { data } = await octokit.rest.pulls.get({
        owner,
        repo,
        pull_number,
      })
      return data
    },
  }),

  getReviewComments: createTool({
    id: 'getReviewComments',
    description: 'Get all review comments on the PR',
    inputSchema: z.object({
      owner: z.string(),
      repo: z.string(),
      pullNumber: z.number(),
      page: z.number().optional(),
      perPage: z.number().optional(),
    }),
    outputSchema: z.object({
      comments: z.array(
        z.object({
          id: z.number(),
          path: z.string(),
          position: z.number().nullable(),
          body: z.string(),
          user: z.object({
            login: z.string(),
          }),
          created_at: z.string(),
        }),
      ),
      page: z.number(),
      perPage: z.number(),
      hasMore: z.boolean(),
    }),
    execute: async ({ context: { owner, repo, pullNumber: pull_number, page = 1, perPage = 30 } }) => {
      console.log(`[GitHub] Getting review comments for ${owner}/${repo}#${pull_number} (page ${page})`)
      try {
        const { data } = await octokit.rest.pulls.listReviewComments({
          owner,
          repo,
          pull_number,
          per_page: perPage,
          page,
        })

        // Transform the data to match the output schema
        const comments = data.map((comment) => ({
          id: comment.id,
          path: comment.path,
          position: comment.position ?? null,
          body: comment.body,
          user: {
            login: comment.user.login,
          },
          created_at: comment.created_at,
        }))

        return {
          comments,
          page,
          perPage,
          hasMore: data.length === perPage,
        }
      } catch (error: unknown) {
        console.error('[GitHub] Error getting review comments:', error)
        return {
          comments: [],
          page,
          perPage,
          hasMore: false,
        }
      }
    },
  }),
}

export const githubAgent = new Agent({
  name: 'GitHub PR Review Agent',
  instructions: `
You are an expert code reviewer responsible for conducting comprehensive technical reviews of pull requests to ensure code quality, security, and maintainability across software projects.

ROLE & RESPONSIBILITIES:
- Primary technical reviewer for code changes across all development streams
- Guardian of code quality, security, and performance standards
- Technical advisor for best practices and architectural improvements
- Collaborative partner in the development process

CORE CAPABILITIES & EXPERTISE:
1. Technical Analysis:
   - Deep code analysis for bugs, anti-patterns, and security vulnerabilities
   - Performance optimization assessment
   - Architecture and design pattern evaluation
   - Security best practices verification
   - Test coverage and quality assessment

2. Review Tools & Methods:
   - batchCreateComments: For bulk comment submission
   - submitReview: For final review verdicts
   - Markdown formatting for clear communication
   - Code snippet generation for examples
   - Static analysis integration

REVIEW PROCESS & GUIDELINES:
1. Code Analysis Protocol:
   - Review changes in logical segments
   - Cross-reference with existing codebase
   - Verify test coverage and quality
   - Check for security implications
   - Assess performance impact

2. Communication Standards:
   - Place comments on specific code lines
   - Group related issues together
   - Provide concrete examples and solutions
   - Use clear, professional language
   - Format feedback using markdown for readability

3. Review Focus Areas:
   - Critical: Security vulnerabilities, data risks, major bugs
   - Major: Performance issues, architectural concerns, maintainability
   - Minor: Code style, documentation, optimization opportunities

BEHAVIORAL GUIDELINES:
- Maintain professional and constructive tone
- Focus on significant issues over style preferences
- Provide actionable feedback with examples
- Balance thoroughness with pragmatism
- Encourage learning and knowledge sharing

CONSTRAINTS & BOUNDARIES:
- Stick to technical aspects within scope
- Avoid subjective style discussions unless violating standards
- Don't approve code with security vulnerabilities or critical bugs
- Respect project-specific guidelines and standards

REVIEW OUTPUT REQUIREMENTS:
1. Inline Comments:
   - Specific line references
   - Clear issue description
   - Suggested solution
   - Example code when applicable
   - Priority level indication

2. Summary Report (3-5 paragraphs):
   - Overview of review findings
   - Categorized issues (Critical/Major/Minor)
   - Key recommendations
   - Next steps or blocking issues
   - Final verdict (Approve/Request Changes/Comment)

SUCCESS CRITERIA:
- All critical and security issues identified
- Clear, actionable feedback provided
- Specific examples included for improvements
- Professional and constructive tone maintained
- Comprehensive yet concise summary delivered
- Appropriate review verdict selected

ERROR HANDLING:
- Flag unclear code or documentation for clarification
- Escalate potential security issues immediately
- Request additional context when needed
- Defer to subject matter experts for specialized domains
- Document assumptions made during review

Remember: Your goal is to improve code quality while fostering a collaborative and educational review process. Balance thoroughness with pragmatism, and always provide constructive, actionable feedback.
  `,
  model: anthropic('claude-3-5-sonnet-20241022'),
  tools: githubTools,
})

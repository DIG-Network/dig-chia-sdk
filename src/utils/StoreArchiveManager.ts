import * as fs from 'fs';
import * as path from 'path';
import * as archiver from 'archiver';
import * as unzipper from 'unzipper';

/**
 * Class for managing file archiving, extraction, and working with the 'data' folder.
 */
class StoreArchiveManager {
    private archivePath: string;
    private outputStream: fs.WriteStream | null;

    /**
     * Constructor that initializes the FileArchiveManager with a given path.
     * @param archivePath - The path where the archive will be created.
     */
    constructor(archivePath: string) {
        this.archivePath = archivePath;
        this.outputStream = null;
    }

    /**
     * Creates the archive at the specified path.
     * @returns Promise<void>
     */
    public async createArchive(): Promise<void> {
        return new Promise((resolve, reject) => {
            this.outputStream = fs.createWriteStream(this.archivePath);
            // @ts-ignore
            const archive = archiver('zip', {
                zlib: { level: 9 }
            });

            this.outputStream.on('close', () => {
                console.log(`${archive.pointer()} total bytes`);
                console.log('Archive has been finalized and output file descriptor has closed.');
                resolve();
            });

            archive.on('error', (err: Error) => {
                reject(err);
            });

            archive.pipe(this.outputStream);
        });
    }

    /**
     * Streams a file into the archive.
     * @param filePath - The file to add to the archive.
     * @param fileNameInArchive - The name the file should have inside the archive.
     * @returns Promise<void>
     */
    public async addFileToArchive(filePath: string, fileNameInArchive: string): Promise<void> {
        if (!this.outputStream) {
            throw new Error('Archive not yet created.');
        }

        return new Promise((resolve, reject) => {
             // @ts-ignore
            const archive = archiver('zip', { zlib: { level: 9 } });
            const fileStream = fs.createReadStream(filePath);
            archive.append(fileStream, { name: fileNameInArchive });

            archive.finalize();
            archive.on('finish', resolve);
            archive.on('error', reject);
        });
    }

    /**
     * Extracts a file from the archive to a specified directory.
     * @param extractToPath - The path where the file should be extracted.
     * @returns Promise<void>
     */
    public async extractArchive(extractToPath: string): Promise<void> {
        return new Promise((resolve, reject) => {
            fs.createReadStream(this.archivePath)
                .pipe(unzipper.Extract({ path: extractToPath }))
                .on('close', resolve)
                .on('error', reject);
        });
    }

    /**
     * Merges another archive into the current one.
     * Extracts files from the given archive and adds them into the current archive.
     * @param archiveToMergePath - The path of the archive to be merged.
     * @returns Promise<void>
     */
    public async mergeArchive(archiveToMergePath: string): Promise<void> {
        if (!this.outputStream) {
            throw new Error('Archive not yet created.');
        }

        return new Promise((resolve, reject) => {
            const tempExtractPath = path.join(__dirname, 'tempExtract');
            
            // Ensure the temp directory exists
            if (!fs.existsSync(tempExtractPath)) {
                fs.mkdirSync(tempExtractPath);
            }

            // Step 1: Extract the contents of the archive to be merged
            fs.createReadStream(archiveToMergePath)
                .pipe(unzipper.Extract({ path: tempExtractPath }))
                .on('close', async () => {
                    try {
                        // Step 2: Read the extracted files and add them to the current archive
                        await this.addExtractedFilesToArchive(tempExtractPath);

                        // Clean up: Delete the temporary directory
                        fs.rmSync(tempExtractPath, { recursive: true, force: true });

                        resolve();
                    } catch (error) {
                        reject(error);
                    }
                })
                .on('error', reject);
        });
    }

    /**
     * Adds extracted files to the current archive.
     * @param extractedFolderPath - The path of the folder containing extracted files.
     * @returns Promise<void>
     */
    private async addExtractedFilesToArchive(extractedFolderPath: string): Promise<void> {
        const files = fs.readdirSync(extractedFolderPath);

        for (const file of files) {
            const fullFilePath = path.join(extractedFolderPath, file);
            const stat = fs.statSync(fullFilePath);

            if (stat.isFile()) {
                const relativePath = path.relative(extractedFolderPath, fullFilePath);

                // Add the file into the current archive
                await this.addFileToArchive(fullFilePath, relativePath);
            } else if (stat.isDirectory()) {
                // Recursively add files from nested directories
                await this.addExtractedFilesToArchive(fullFilePath);
            }
        }
    }
}

export default StoreArchiveManager;

import {
  JsonController,
  Post,
  Get,
  Body,
  Param,
  Authorized,
  HttpCode,
  Req,
  Res,
  NotFoundError,
  Delete,
  BadRequestError,
} from 'routing-controllers';
import { Request, Response } from 'express';
import multer from 'multer';
import { pollSocket } from '../utils/PollSocket.js';
import { inject, injectable } from 'inversify';
import { RoomService } from '../services/RoomService.js';
import { PollService } from '../services/PollService.js';
import { LIVE_QUIZ_TYPES } from '../types.js';
//import { TranscriptionService } from '#root/modules/genai/services/TranscriptionService.js';
import { AIContentService } from '#root/modules/genai/services/AIContentService.js';
import { VideoService } from '#root/modules/genai/services/VideoService.js';
import { AudioService } from '#root/modules/genai/services/AudioService.js';
import { CleanupService } from '#root/modules/genai/services/CleanupService.js';
import type { QuestionSpec } from '#root/modules/genai/services/AIContentService.js';
// import type { File as MulterFile } from 'multer';
import { OpenAPI } from 'routing-controllers-openapi';
import dotenv from 'dotenv';
import mime from 'mime-types';
import * as fsp from 'fs/promises';

dotenv.config();
const appOrigins = process.env.APP_ORIGINS;

declare module 'express-serve-static-core' {
  interface Request {
    file?: Express.Multer.File;
    files?: Express.Multer.File[];
  }
}
const upload = multer({ dest: 'uploads/' });

@injectable()
@OpenAPI({tags: ['Rooms'],})
@JsonController('/livequizzes/rooms')
export class PollRoomController {
  constructor(
    @inject(LIVE_QUIZ_TYPES.VideoService) private videoService: VideoService,
    @inject(LIVE_QUIZ_TYPES.AudioService) private audioService: AudioService,
    //@inject(LIVE_QUIZ_TYPES.TranscriptionService) private transcriptionService: TranscriptionService,
    @inject(LIVE_QUIZ_TYPES.AIContentService) private aiContentService: AIContentService,
    @inject(LIVE_QUIZ_TYPES.CleanupService) private cleanupService: CleanupService,
    @inject(LIVE_QUIZ_TYPES.RoomService) private roomService: RoomService,
    @inject(LIVE_QUIZ_TYPES.PollService) private pollService: PollService,
  ) { }

  //@Authorized(['teacher'])
  @Post('/')
  async createRoom(@Body() body: { name: string; teacherId: string }) {
    const room = await this.roomService.createRoom(body.name, body.teacherId);
    return {
      ...room,
      inviteLink: `${appOrigins}/student/pollroom/${room.roomCode}`,
    };
  }

  //@Authorized()
  @Get('/:code')
  async getRoom(@Param('code') code: string) {
    const room = await this.roomService.getRoomByCode(code);
    if (!room) {
      return { success: false, message: 'Room not found' };
    }
    if (room.status !== 'active') {
      return { success: false, message: 'Room is ended' };
    }
    return { success: true, room };  // return room data
  }  

  // 🔹 Create Poll in Room
  //@Authorized(['teacher','admin'])
  @Post('/:code/polls')
  async createPollInRoom(
    @Param('code') roomCode: string,
    @Body() body: { question: string; options: string[]; correctOptionIndex: number; creatorId: string; timer?: number }
  ) {
    const room = await this.roomService.getRoomByCode(roomCode);
    if (!room) throw new Error('Invalid room');
    return await this.pollService.createPoll(
      roomCode,
      {
        question: body.question,
        options: body.options,
        correctOptionIndex: body.correctOptionIndex,
        timer: body.timer
      }
    );

  }

  //@Authorized(['teacher'])
  @Get('/teacher/:teacherId')
  async getAllRoomsByTeacher(@Param('teacherId') teacherId: string) {
    return await this.roomService.getRoomsByTeacher(teacherId);
  }
  //@Authorized(['teacher'])
  @Get('/teacher/:teacherId/active')
  async getActiveRoomsByTeacher(@Param('teacherId') teacherId: string) {
    return await this.roomService.getRoomsByTeacherAndStatus(teacherId, 'active');
  }
  //@Authorized(['teacher'])
  @Get('/teacher/:teacherId/ended')
  async getEndedRoomsByTeacher(@Param('teacherId') teacherId: string) {
    return await this.roomService.getRoomsByTeacherAndStatus(teacherId, 'ended');
  }

  //@Authorized(['teacher'])
  @Get('/:roomId/analysis')
  async getPollAnalysis(@Param('roomId') roomId: string) {
    // Fetch from service
    const analysis = await this.roomService.getPollAnalysis(roomId);
    return { success: true, data: analysis };
  }

  //@Authorized()
  @Post('/:code/polls/answer')
  async submitPollAnswer(
    @Param('code') roomCode: string,
    @Body() body: { pollId: string; userId: string; answerIndex: number }
  ) {
    await this.pollService.submitAnswer(roomCode, body.pollId, body.userId, body.answerIndex);
    return { success: true };
  }

  // Fetch Results for All Polls in Room
  //@Authorized()
  @Get('/:code/polls/results')
  async getResultsForRoom(@Param('code') code: string) {
    return await this.pollService.getPollResults(code);
  }

  //@Authorized(['teacher'])
  @Post('/:code/end')
  async endRoom(@Param('code') code: string) {
    const success = await this.roomService.endRoom(code);
    if (!success) throw new Error('Room not found');
    // Emit to all clients in the room
    pollSocket.emitToRoom(code, 'room-ended', {});
    return { success: true, message: 'Room ended successfully' };
  }

@Get('/youtube-audio')
@HttpCode(200)
async getYoutubeAudio(@Req() req: Request, @Res() res: Response) {
  const youtubeUrl = req.query.url as string;
  const tempPaths: string[] = [];
  try {
    if (!youtubeUrl) {
      return res.status(400).json({ message: 'Missing YouTube URL.' });
    }
    console.log('Received YouTube URL:', youtubeUrl);
    // 1. Download the YouTube video (MP4 or similar)
    const videoPath = await this.videoService.downloadVideo(youtubeUrl);
    tempPaths.push(videoPath);

    // 2. Extract audio from video (MP3 or WAV)
    const audioPath = await this.audioService.extractAudio(videoPath);
    tempPaths.push(audioPath);

    // 3. Stream audio file to the client
    const mimeType = mime.lookup(audioPath) || 'audio/mpeg';
    const audioBuffer = await fsp.readFile(audioPath); 

    res.setHeader('Content-Type', mimeType);
    res.setHeader('Content-Length', audioBuffer.length);
    res.setHeader('Content-Disposition', 'inline');

    console.log("🧪 Audio path:", audioPath);
    console.log("📦 Audio buffer size:", audioBuffer.length); // << This will likely be 44
    return res.send(audioBuffer);
  } catch (error: any) {
    console.error('Error in /youtube-audio:', error);
    await this.cleanupService.cleanup(tempPaths);
    return res.status(500).json({ message: error.message || 'Internal Server Error' });
  }
}

  // 🔹 AI Question Generation from transcript or YouTube
  //@Authorized(['teacher'])
  @Post('/:code/generate-questions')
  @HttpCode(200)
  async generateQuestionsFromTranscript(
    @Req() req: Request,
    @Res() res: Response
  ) {
    const tempPaths: string[] = [];

    await new Promise<void>((resolve, reject) => {
      upload.single('file')(req, res, (err) => (err ? reject(err) : resolve()));
    });

    try {
      const { transcript, questionSpec, model, questionCount } = req.body;

      const SEGMENTATION_THRESHOLD = parseInt(process.env.TRANSCRIPT_SEGMENTATION_THRESHOLD || '6000', 10);
      const defaultModel = 'gemma3';
      const selectedModel = model?.trim() || defaultModel;

      // Parse questionCount with default value
      const numQuestions = questionCount ? parseInt(questionCount, 10) : 2;

      let segments: Record<string, string>;
      if (transcript.length <= SEGMENTATION_THRESHOLD) {
        console.log('[generateQuestions] Small transcript detected. Using full transcript without segmentation.');
        console.log('Transcript:', transcript);
        segments = { full: transcript };
      } else {
        console.log('[generateQuestions] Transcript is long; running segmentation...');
        segments = await this.aiContentService.segmentTranscript(transcript, selectedModel);
      }

      // ✅ Safe default questionSpec with custom count
      let safeSpec: QuestionSpec[] = [{ SOL: numQuestions }];
      if (questionSpec && typeof questionSpec === 'object' && !Array.isArray(questionSpec)) {
        safeSpec = [questionSpec];
      } else if (Array.isArray(questionSpec) && typeof questionSpec[0] === 'object') {
        safeSpec = questionSpec;
      } else {
        console.warn(`Invalid questionSpec provided; using default [{ SOL: ${numQuestions} }]`);
      }
      console.log('Using questionSpec:', safeSpec);
      console.log('[generateQuestions] Transcript length:', transcript.length);
      console.log('[generateQuestions] Transcript preview:', segments);
     
      console.log('[generateQuestions] Number of questions to generate:', numQuestions);
      const generatedQuestions = await this.aiContentService.generateQuestions({
        segments,
        globalQuestionSpecification: safeSpec,
        model: selectedModel,
      });

      return res.json({
        message: 'Questions generated successfully from transcript.',
        transcriptPreview: transcript.substring(0, 200) + '...',
        segmentsCount: Object.keys(segments).length,
        totalQuestions: generatedQuestions.length,
        requestedQuestions: numQuestions,
        questions: generatedQuestions,
      });
    } catch (err: any) {
      console.error('Error generating questions:', err);
      return res.status(err.status || 500).json({ message: err.message || 'Internal Server Error' });
    } finally {
      await this.cleanupService.cleanup(tempPaths);
    }
  }
  
   // In-memory poll endpoints
  @Post('/:code/in-memory-polls')
  @Authorized()
  @OpenAPI({
    summary: 'Create a new in-memory poll',
    description: 'Creates a new in-memory poll in the specified room',
    responses: {
      '201': { description: 'Poll created successfully' },
      '400': { description: 'Invalid input' },
      '401': { description: 'Unauthorized' },
      '404': { description: 'Room not found' }
    }
  })
  async createInMemoryPoll(
    @Param('code') roomCode: string,
    @Body() body: CreateInMemoryPollDto
  ): Promise<InMemoryPollResponse> {
    // Validate input
    const errors = await validate(body);
    if (errors.length > 0) {
      throw new BadRequestError(`Validation failed: ${errors.toString()}`);
    }

    // Verify room exists
    const room = await this.roomService.getRoomByCode(roomCode);
    if (!room) {
      throw new NotFoundError('Room not found');
    }

    // Validate correctOptionIndex is within bounds
    if (body.correctOptionIndex >= body.options.length) {
      throw new BadRequestError('correctOptionIndex is out of bounds');
    }

    try {
      const poll = await this.pollService.createInMemoryPoll(
        roomCode,
        {
          question: body.question,
          options: body.options,
          correctOptionIndex: body.correctOptionIndex,
          timer: body.timer
        }
      );

      return poll;
    } catch (error) {
      console.error('Error creating in-memory poll:', error);
      throw new BadRequestError('Failed to create poll');
    }
  }

  @Post('/:code/in-memory-polls/:pollId/answer')
  @Authorized()
  @OpenAPI({
    summary: 'Submit an answer to an in-memory poll',
    description: 'Submits an answer to the specified in-memory poll',
    responses: {
      '200': { description: 'Answer submitted successfully' },
      '400': { description: 'Invalid input' },
      '401': { description: 'Unauthorized' },
      '404': { description: 'Poll not found' }
    }
  })
  async submitInMemoryAnswer(
    @Param('code') roomCode: string,
    @Param('pollId') pollId: string,
    @Body() body: SubmitInMemoryAnswerDto
  ): Promise<{ success: boolean }> {
    // Validate input
    const errors = await validate(body);
    if (errors.length > 0) {
      throw new BadRequestError(`Validation failed: ${errors.toString()}`);
    }

    try {
      await this.pollService.submitInMemoryAnswer(
        roomCode,
        pollId,
        body.userId,
        body.answerIndex
      );
      return { success: true };
    } catch (error) {
      console.error('Error submitting answer:', error);
      throw new BadRequestError('Failed to submit answer');
    }
  }

  @Get('/:code/in-memory-polls/:pollId/results')
  @Authorized()
  @OpenAPI({
    summary: 'Get results for an in-memory poll',
    description: 'Retrieves the current results for the specified in-memory poll',
    responses: {
      '200': { description: 'Poll results retrieved successfully' },
      '401': { description: 'Unauthorized' },
      '404': { description: 'Poll not found' }
    }
  })
  async getInMemoryPollResults(
    @Param('code') roomCode: string,
    @Param('pollId') pollId: string
  ): Promise<InMemoryPollResult> {
    const results = await this.pollService.getInMemoryPollResults(roomCode, pollId);
    if (!results) {
      throw new NotFoundError('Poll not found or no results available');
    }
    return results;
  }

  @Post('/:code/in-memory-polls/:pollId/end')
  @Authorized()
  @OpenAPI({
    summary: 'End an in-memory poll',
    description: 'Ends the specified in-memory poll and calculates final results',
    responses: {
      '200': { description: 'Poll ended successfully' },
      '401': { description: 'Unauthorized' },
      '404': { description: 'Poll not found' }
    }
  })
  async endInMemoryPoll(
    @Param('code') roomCode: string,
    @Param('pollId') pollId: string
  ): Promise<{ success: boolean }> {
    try {
      await this.pollService.endInMemoryPoll(roomCode, pollId);
      return { success: true };
    } catch (error) {
      console.error('Error ending poll:', error);
      throw new BadRequestError('Failed to end poll');
    }
  }

  @Delete('/:code/in-memory-polls/:pollId')
  @Authorized()
  @OpenAPI({
    summary: 'Delete an in-memory poll',
    description: 'Deletes the specified in-memory poll',
    responses: {
      '200': { description: 'Poll deleted successfully' },
      '401': { description: 'Unauthorized' },
      '404': { description: 'Poll not found' }
    }
  })
  async deleteInMemoryPoll(
    @Param('code') roomCode: string,
    @Param('pollId') pollId: string
  ): Promise<{ success: boolean }> {
    const success = await this.pollService.deleteInMemoryPoll(roomCode, pollId);
    if (!success) {
      throw new NotFoundError('Poll not found');
    }
    return { success: true };
  }

  @Get('/:code/in-memory-polls')
  @Authorized()
  @OpenAPI({
    summary: 'Get all active in-memory polls',
    description: 'Retrieves all active in-memory polls for the specified room',
    responses: {
      '200': { description: 'Active polls retrieved successfully' },
      '401': { description: 'Unauthorized' },
      '404': { description: 'Room not found' }
    }
  })
  async getActiveInMemoryPolls(
    @Param('code') roomCode: string
  ): Promise<InMemoryPollResponse[]> {
    // Verify room exists
    const room = await this.roomService.getRoomByCode(roomCode);
    if (!room) {
      throw new NotFoundError('Room not found');
    }

    return this.pollService.getActiveInMemoryPolls(roomCode);
  }
}


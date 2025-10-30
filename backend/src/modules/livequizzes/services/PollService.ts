import { injectable, inject } from 'inversify';
import crypto from 'crypto';
import { Room } from '../../../shared/database/models/Room.js';
import { pollSocket } from '../utils/PollSocket.js';
import { UserModel } from '#root/shared/database/models/User.js';

interface InMemoryPoll {
  pollId: string;
  question: string;
  options: string[];
  correctOptionIndex: number;
  responses: Record<string, number>; // optionIndex: count
  totalResponses: number;
  userResponses: Map<string, number>; // userId: optionIndex
  timer: number;
  startTime?: number;
  timeLeft: number;
  roomCode: string;
}

@injectable()
export class PollService {
  private pollSocket = pollSocket;
  private activePolls = new Map<string, InMemoryPoll>(); // pollId -> InMemoryPoll
  private pollTimers = new Map<string, NodeJS.Timeout>(); // pollId -> timer
  async createPoll(roomCode: string, data: {
    question: string;
    options: string[];
    correctOptionIndex: number;
    timer?: number;
  }) {
    const pollId = crypto.randomUUID();

    const poll = {
      _id: pollId,
      question: data.question,
      options: data.options,
      correctOptionIndex: data.correctOptionIndex,
      timer: data.timer ?? 30,
      createdAt: new Date(),
      answers: []
    };

    const livepoll: InMemoryPoll = {
      pollId,
      question: data.question,
      options: data.options,
      correctOptionIndex: data.correctOptionIndex,
      responses: {},
      totalResponses: 0,
      userResponses: new Map(),
      timer: data.timer ?? 0, // 0 means no timer
      timeLeft: data.timer ?? 0,
      roomCode,
    };

    await Room.updateOne(
      { roomCode },
      { $push: { polls: poll } }
    );

    this.activePolls.set(pollId, livepoll);
    // localStorage.setItem('activePolls', JSON.stringify(this.activePolls));

    // Start timer if specified
    if (poll.timer > 0) {
      this.startPollTimer(pollId);
    }

    pollSocket.emitToRoom(roomCode, 'new-poll', poll);
    return poll;
  }



  async submitAnswer(roomCode: string, pollId: string, userId: string, answerIndex: number) {

    const poll = this.activePolls.get(pollId);
    if (!poll || poll.roomCode !== roomCode) {
      throw new Error('Poll not found or invalid room');
    }

    // Update in-memory response tracking
    const previousResponse = poll.userResponses.get(userId);

    // If user already answered, decrement previous response count
    if (previousResponse !== undefined) {
      const prevOption = previousResponse.toString();
      poll.responses[prevOption] = (poll.responses[prevOption] || 1) - 1;
      poll.totalResponses--;
    }

    // Update new response
    poll.userResponses.set(userId, answerIndex);
    const optionKey = answerIndex.toString();
    poll.responses[optionKey] = (poll.responses[optionKey] || 0) + 1;
    poll.totalResponses++;

    // Emit update to all clients
    this.emitPollUpdate(roomCode, pollId);

    await Room.updateOne(
      { roomCode, "polls._id": pollId },
      { $push: { "polls.$.answers": { userId, answerIndex, answeredAt: new Date() } } }
    );
  }

  async getPollResults(roomCode: string) {
    const room = await Room.findOne({ roomCode });
    if (!room) return null;

    const results: Record<string, Record<string, { count: number; users: { id: string; name: string }[] }>> = {};

    for (const poll of room.polls) {
      const counts = Array(poll.options.length).fill(0);
      const userIds = poll.options.map(() => [] as string[]);

      for (const ans of poll.answers) {
        if (ans.answerIndex >= 0 && ans.answerIndex < poll.options.length) {
          counts[ans.answerIndex]++;
          userIds[ans.answerIndex].push(ans.userId);
        }
      }
      const allUserIds = [...new Set(poll.answers.map(ans => ans.userId))];
      const users = await UserModel.find({ firebaseUID: { $in: allUserIds } }, { firebaseUID: 1, firstName: 1, lastName: 1 });
      const userMap = new Map(users.map(user => {
        const fullName = `${user.firstName || ''} ${user.lastName || ''}`.trim() || 'Unknown User';
        return [user.firebaseUID, { id: user.firebaseUID, name: fullName }];
      }));

      const pollResult = poll.options.reduce((acc, opt, i) => {
        const usersForOption = userIds[i].map(userId => {
          const user = userMap.get(userId);
          return user || { id: userId, name: 'Unknown User' };
        });
        acc[opt] = {
          count: counts[i],
          users: usersForOption
        };
        return acc;
      }, {} as Record<string, { count: number; users: { id: string; name: string }[] }>);

      results[poll.question] = pollResult;
    }

    return results;
  }


  async submitInMemoryAnswer(roomCode: string, pollId: string, userId: string, answerIndex: number) {
    const poll = this.activePolls.get(pollId);
    if (!poll || poll.roomCode !== roomCode) {
      throw new Error('Poll not found or invalid room');
    }

    // Remove previous response if user already voted
    if (poll.userResponses.has(userId)) {
      const prevAnswerIndex = poll.userResponses.get(userId)!;
      poll.responses[prevAnswerIndex]--;
      poll.totalResponses--;
    }

    // Add new response
    poll.userResponses.set(userId, answerIndex);
    poll.responses[answerIndex] = (poll.responses[answerIndex] || 0) + 1;
    poll.totalResponses++;

    // Emit update to all clients
    this.emitPollUpdate(roomCode, pollId);

    return this.getPollData(poll);
  }


  async endInMemoryPoll(roomCode: string, pollId: string) {
    const poll = this.activePolls.get(pollId);
    if (!poll || poll.roomCode !== roomCode) return;

    // Clear timer if exists
    const timer = this.pollTimers.get(pollId);
    if (timer) {
      clearInterval(timer);
      this.pollTimers.delete(pollId);
    }

    // Emit final results
    this.pollSocket.emitToRoom(roomCode, 'in-memory-poll-ended', {
      pollId: poll.pollId,
      responses: { ...poll.responses },
      totalResponses: poll.totalResponses
    });
  }

  async deleteInMemoryPoll(roomCode: string, pollId: string) {
    const poll = this.activePolls.get(pollId);
    if (!poll || poll.roomCode !== roomCode) return false;

    // Clear timer if exists
    const timer = this.pollTimers.get(pollId);
    if (timer) {
      clearInterval(timer);
      this.pollTimers.delete(pollId);
    }

    // Remove from active polls
    this.activePolls.delete(pollId);
    return true;
  }

  getActiveInMemoryPolls(roomCode: string) {
    return Array.from(this.activePolls.values())
      .filter(poll => poll.roomCode === roomCode)
      .map(poll => this.getPollData(poll));
  }

  // Helper methods
  private startPollTimer(pollId: string) {
    const poll = this.activePolls.get(pollId);
    if (!poll || poll.timer <= 0) return;

    poll.startTime = Date.now();

    const updateInterval = setInterval(() => {
      const now = Date.now();
      const elapsed = Math.floor((now - (poll.startTime || now)) / 1000);
      poll.timeLeft = Math.max(0, poll.timer - elapsed);

      // Emit time update
      this.pollSocket.emitToRoom(poll.roomCode, 'in-memory-poll-time-update', {
        pollId: poll.pollId,
        timeLeft: poll.timeLeft
      });

      // End poll if time's up
      if (poll.timeLeft <= 0) {
        clearInterval(updateInterval);
        this.pollTimers.delete(pollId);
        this.endInMemoryPoll(poll.roomCode, poll.pollId);
      }
    }, 1000);

    // Store the interval
    this.pollTimers.set(pollId, updateInterval);
  }

  private emitPollUpdate(roomCode: string, pollId: string) {
    const poll = this.activePolls.get(pollId);
    if (!poll) return;

    const pollData = this.getPollData(poll);

    // Also update the room data
    // Emit to all clients in the room
    console.log(`[POLL Service]Emitting in-memory-poll-update for room ${roomCode}:`, pollData);
    this.pollSocket.emitToAll(roomCode, 'in-memory-poll-update', pollData);
  }

  private getPollData(poll: InMemoryPoll) {
    // Calculate correct percentage
    const correctResponses = poll.responses[poll.correctOptionIndex] || 0;
    const correctPercentage = poll.totalResponses > 0
      ? Math.round((correctResponses / poll.totalResponses) * 100)
      : 0;

    // Convert userResponses Map to plain object
    const userResponses = Object.fromEntries(poll.userResponses);

    return {
      pollId: poll.pollId,
      question: poll.question,
      options: poll.options,
      correctOptionIndex: poll.correctOptionIndex,
      responses: { ...poll.responses },
      totalResponses: poll.totalResponses,
      timeLeft: poll.timeLeft,
      timer: poll.timer,
      correctPercentage,
      userResponses,
      roomCode: poll.roomCode,
    };
  }
}

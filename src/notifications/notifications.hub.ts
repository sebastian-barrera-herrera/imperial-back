import { Injectable, OnModuleDestroy } from '@nestjs/common';
import { Observable, interval, map, merge } from 'rxjs';

type HubMessage = { type: string; data: unknown };
type Listener = (message: HubMessage) => void;

/** Difusión en memoria hacia las conexiones SSE abiertas de cada usuario (una sola instancia de API). */
@Injectable()
export class NotificationsHub implements OnModuleDestroy {
  private readonly listeners = new Map<string, Set<Listener>>();
  private readonly closers = new Set<() => void>();

  /** Cierra los streams abiertos para que el apagado ordenado del servidor no quede esperando conexiones SSE. */
  onModuleDestroy() {
    this.closers.forEach((close) => close());
    this.closers.clear();
  }

  emit(userId: string, message: HubMessage) {
    this.listeners.get(userId)?.forEach((listener) => listener(message));
  }

  connectedUserIds(): string[] {
    return [...this.listeners.keys()];
  }

  stream(userId: string): Observable<{ type: string; data: unknown }> {
    const events = new Observable<HubMessage>((subscriber) => {
      const listener: Listener = (message) => subscriber.next(message);
      const set = this.listeners.get(userId) ?? new Set<Listener>();
      set.add(listener);
      this.listeners.set(userId, set);
      const closer = () => subscriber.complete();
      this.closers.add(closer);
      return () => {
        this.closers.delete(closer);
        set.delete(listener);
        if (set.size === 0) this.listeners.delete(userId);
      };
    });
    const heartbeat = interval(25_000).pipe(map((): HubMessage => ({ type: 'ping', data: {} })));
    return merge(events, heartbeat);
  }
}

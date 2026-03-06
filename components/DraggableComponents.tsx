import { useDraggable } from '@dnd-kit/core';
import { useDroppable } from '@dnd-kit/core';
import { ReactNode } from 'react';

interface DroppableFolderProps {
    id: string;
    children: ReactNode;
}

export function DroppableFolder({ id, children }: DroppableFolderProps) {
    const { setNodeRef, isOver } = useDroppable({
        id,
        data: { type: 'category' }
    });

    return (
        <div
            ref={setNodeRef}
            className={`transition-all duration-200 ${isOver ? 'ring-2 ring-indigo-500 ring-offset-2 scale-[1.02]' : ''}`}
        >
            {children}
        </div>
    );
}

interface DraggableHandleProps {
    id: string;
    type: 'category' | 'recipe';
    children: ReactNode;
}

export function DraggableHandle({ id, type, children }: DraggableHandleProps) {
    const { attributes, listeners, setNodeRef, isDragging } = useDraggable({
        id,
        data: { type }
    });

    return (
        <div
            ref={setNodeRef}
            {...attributes}
            {...listeners}
            className={`cursor-move ${isDragging ? 'opacity-50' : ''}`}
        >
            {children}
        </div>
    );
}

interface DraggableRecipeProps {
    id: string;
    children: (dragHandleProps: { attributes: any; listeners: any }) => ReactNode;
}

export function DraggableRecipe({ id, children }: DraggableRecipeProps) {
    const { attributes, listeners, setNodeRef, isDragging, transform } = useDraggable({
        id,
        data: { type: 'recipe' }
    });

    const style = transform ? {
        transform: `translate3d(${transform.x}px, ${transform.y}px, 0)`,
    } : undefined;

    return (
        <div
            ref={setNodeRef}
            style={style}
            className={`${isDragging ? 'opacity-40 scale-95 z-50 pointer-events-none' : 'transition-all duration-200'}`}
        >
            {children({ attributes, listeners })}
        </div>
    );
}

interface DraggableFolderProps {
    id: string;
    children: (dragHandleProps: { attributes: any; listeners: any }) => ReactNode;
}

export function DraggableFolderItem({ id, children }: DraggableFolderProps) {
    const { attributes, listeners, setNodeRef, isDragging, transform } = useDraggable({
        id,
        data: { type: 'category' }
    });

    const style = transform ? {
        transform: `translate3d(${transform.x}px, ${transform.y}px, 0)`,
    } : undefined;

    return (
        <div
            ref={setNodeRef}
            style={style}
            className={`${isDragging ? 'opacity-40 scale-95 z-50 pointer-events-none' : 'transition-all duration-200'}`}
        >
            {children({ attributes, listeners })}
        </div>
    );
}

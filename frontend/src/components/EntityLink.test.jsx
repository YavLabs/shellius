import { describe, expect, it, vi } from 'vitest';
import { render, screen, fireEvent } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
import EntityLink from './EntityLink';

const mockUser = { role: 'member', permissions: [] };
let currentUser = mockUser;

vi.mock('@/context/AuthContext', () => ({
  useAuth: () => ({ user: currentUser }),
}));

function renderWithRouter(ui) {
  return render(<MemoryRouter>{ui}</MemoryRouter>);
}

describe('EntityLink', () => {
  it('renders a focusable link when the viewer can open the destination', () => {
    currentUser = { role: 'admin', permissions: ['servers.view'] };
    renderWithRouter(
      <EntityLink to="/servers/abc" entityType="server" entityName="db-1">
        db-1
      </EntityLink>
    );
    const link = screen.getByRole('link', { name: 'Open server db-1' });
    expect(link).toHaveAttribute('href', '/servers/abc');
    expect(link).toHaveTextContent('db-1');
  });

  it('degrades to plain text when the viewer lacks access to the destination', () => {
    currentUser = { role: 'member', permissions: [] };
    renderWithRouter(
      <EntityLink to="/servers/abc" entityType="server" entityName="db-1">
        db-1
      </EntityLink>
    );
    expect(screen.queryByRole('link')).not.toBeInTheDocument();
    expect(screen.getByText('db-1')).toBeInTheDocument();
  });

  it('degrades to plain text when there is no id to link to', () => {
    currentUser = { role: 'admin', permissions: ['servers.view'] };
    renderWithRouter(
      <EntityLink to={null} entityType="server" entityName="db-1">
        db-1
      </EntityLink>
    );
    expect(screen.queryByRole('link')).not.toBeInTheDocument();
    expect(screen.getByText('db-1')).toBeInTheDocument();
  });

  it('stops the click from bubbling to an enclosing clickable row', () => {
    currentUser = { role: 'admin', permissions: ['servers.view'] };
    const rowClick = vi.fn();
    renderWithRouter(
      <div onClick={rowClick}>
        <EntityLink to="/servers/abc" entityType="server" entityName="db-1">
          db-1
        </EntityLink>
      </div>
    );
    fireEvent.click(screen.getByRole('link', { name: 'Open server db-1' }));
    expect(rowClick).not.toHaveBeenCalled();
  });
});

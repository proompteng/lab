use std::sync::{Mutex, OnceLock};

#[repr(C)]
pub struct ByteArray {
    pub ptr: *mut u8,
    pub len: usize,
    pub cap: usize,
}

impl ByteArray {
    pub fn from_vec(mut vec: Vec<u8>) -> *mut ByteArray {
        let ptr = vec.as_mut_ptr();
        let len = vec.len();
        let cap = vec.capacity();
        std::mem::forget(vec);
        Box::into_raw(Box::new(ByteArray { ptr, len, cap }))
    }

    pub fn empty() -> *mut ByteArray {
        ByteArray::from_vec(Vec::new())
    }
}

const MAX_BUFFER_CAPACITY: usize = 32 * 1024 * 1024; // 32 MiB ceiling per pooled buffer.
const MAX_POOL_SIZE: usize = 16;

static BYTE_ARRAY_POOL: OnceLock<Mutex<Vec<Vec<u8>>>> = OnceLock::new();

#[cfg(test)]
static TEST_MUTEX: OnceLock<Mutex<()>> = OnceLock::new();

fn pool() -> &'static Mutex<Vec<Vec<u8>>> {
    BYTE_ARRAY_POOL.get_or_init(|| Mutex::new(Vec::new()))
}

pub fn take(len: usize) -> Vec<u8> {
    if len == 0 {
        return Vec::new();
    }

    let mut guard = pool().lock().unwrap();

    let mut selected_index: Option<usize> = None;
    let mut selected_capacity = usize::MAX;

    for (idx, buffer) in guard.iter().enumerate() {
        let capacity = buffer.capacity();
        if capacity >= len && capacity < selected_capacity {
            selected_index = Some(idx);
            selected_capacity = capacity;
            if capacity == len {
                break;
            }
        }
    }

    if let Some(index) = selected_index {
        let mut buffer = guard.swap_remove(index);
        buffer.clear();
        return buffer;
    }

    Vec::with_capacity(len)
}

pub fn recycle(mut buffer: Vec<u8>) {
    if buffer.capacity() == 0 || buffer.capacity() > MAX_BUFFER_CAPACITY {
        return;
    }

    buffer.clear();

    let mut guard = pool().lock().unwrap();
    if guard.len() >= MAX_POOL_SIZE {
        return;
    }

    guard.push(buffer);
}

#[cfg(test)]
pub fn clear_pool() {
    pool().lock().unwrap().clear();
}

#[cfg(test)]
pub fn pool_len() -> usize {
    pool().lock().unwrap().len()
}

#[cfg(test)]
pub fn test_lock() -> std::sync::MutexGuard<'static, ()> {
    TEST_MUTEX.get_or_init(|| Mutex::new(())).lock().unwrap()
}
